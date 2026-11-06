using System.Text.Json;
using System.Text.Json.Serialization;
using OpenClaw.Shared;
using OpenClaw.Shared.ExecApprovals;

namespace MicroClaw.WindowsNodeHost;

internal sealed record CommandConsentPreview(
    [property: JsonPropertyName("required")] bool Required,
    [property: JsonPropertyName("allowAlwaysAvailable")] bool AllowAlwaysAvailable);

internal sealed record PreparedCommandConsent(
    ExecApprovedExecution Execution,
    CommandConsentPreview Preview);

internal sealed class CommandConsent(ExecApprovalsStore store, IOpenClawLogger logger)
{
    public const string AskWhenNeeded = "ask-when-needed";
    public const string AllowAlways = "allow-always";

    public async Task SetModeAsync(string mode)
    {
        if (mode is not (AskWhenNeeded or AllowAlways))
            throw new HostPolicyException("consent-mode-invalid", "Unknown command consent mode.");
        var snapshot = await store.GetSnapshotAsync();
        var defaults = new ExecApprovalsDefaults
        {
            Security = mode == AllowAlways ? ExecSecurity.Full : ExecSecurity.Allowlist,
            Ask = mode == AllowAlways ? ExecAsk.Off : ExecAsk.OnMiss,
            AskFallback = ExecSecurity.Deny,
            AutoAllowSkills = false,
        };
        snapshot.File.Defaults = defaults;
        foreach (var agent in snapshot.File.Agents?.Values.AsEnumerable() ?? [])
        {
            agent.Security = null;
            agent.Ask = null;
            agent.AskFallback = null;
            agent.AutoAllowSkills = null;
        }
        if (await store.ReplaceAsync(snapshot.Hash, snapshot.File) is null)
            throw new HostPolicyException("consent-policy-changed", "Command consent changed while applying settings.");
    }

    public async Task<PreparedCommandConsent> PrepareAsync(NodeInvokeRequest request)
    {
        // Preparation may derive execution bytes, but grants no launch authority and
        // never chooses AllowAlways. Dispatch still requires a signed desktop decision.
        var prompt = new DecisionPrompt("allow-once");
        var result = await Coordinator(prompt).HandleAsync(request, request.Id);
        if (!result.IsAllow || result.Execution is null)
            throw new HostPolicyException("command-consent-denied", result.Reason);
        return new PreparedCommandConsent(result.Execution,
            new CommandConsentPreview(prompt.Request is not null,
                prompt.Request?.AllowAlwaysAvailable == true));
    }

    public async Task<ExecApprovedExecution> AuthorizeAsync(NodeInvokeRequest request, string decision)
    {
        if (decision is not ("allow-once" or "allow-always" or "policy"))
            throw new HostPolicyException("consent-decision-invalid", "Unknown command consent decision.");
        var result = await Coordinator(new DecisionPrompt(decision)).HandleAsync(request, request.Id);
        if (!result.IsAllow || result.Execution is null)
            throw new HostPolicyException("command-consent-denied", result.Reason);
        return result.Execution;
    }

    public async Task RevalidateAsync(ExecApprovedExecution execution, CancellationToken cancellationToken)
    {
        var result = await Coordinator(new DecisionPrompt("policy"))
            .RevalidateAsync(execution, "microclaw-launch", cancellationToken);
        if (!result.IsCurrent)
            throw new HostPolicyException("consent-policy-changed", result.Reason ?? "Command consent changed before launch.");
    }

    internal static NodeInvokeRequest Request(
        IReadOnlyList<string> argv, string? cwd, int timeoutMs, string? agentId, string? sessionKey) =>
        new()
        {
            Id = Guid.NewGuid().ToString("N"),
            Command = "system.run",
            Args = JsonSerializer.SerializeToElement(new
            {
                command = argv,
                cwd,
                timeoutMs,
                agentId,
                sessionKey,
            }, new JsonSerializerOptions { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull }),
        };

    private ExecApprovalsCoordinator Coordinator(IExecApprovalV2PromptHandler prompt) =>
        new(store, AlwaysCanPresentEvaluator.Instance, prompt, logger);

    private sealed class DecisionPrompt(string decision) : IExecApprovalV2PromptHandler
    {
        public ExecApprovalV2PromptRequest? Request { get; private set; }

        public Task<ExecApprovalPromptOutcome> PromptAsync(
            ExecApprovalV2PromptRequest request, CancellationToken cancellationToken = default)
        {
            Request = request;
            return Task.FromResult(cancellationToken.IsCancellationRequested
                ? ExecApprovalPromptOutcome.Deny
                : decision switch
                {
                    "allow-once" => ExecApprovalPromptOutcome.AllowOnce,
                    "allow-always" when request.AllowAlwaysAvailable => ExecApprovalPromptOutcome.AllowAlways,
                    _ => ExecApprovalPromptOutcome.Deny,
                });
        }
    }
}
