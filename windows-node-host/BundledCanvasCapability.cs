using System.Text.Json;
using OpenClaw.Shared;

namespace MicroClaw.WindowsNodeHost;

internal sealed class BundledCanvasCapability(
    CanvasHostBroker broker,
    ActivationLeaseGuard activationLease) : INodeCapability
{
    public string Category => "canvas";
    public IReadOnlyList<string> Commands => CanvasPhase1Policy.Commands;
    public bool CanHandle(string command) =>
        CanvasPhase1Policy.Commands.Contains(command, StringComparer.Ordinal);
    public Task<NodeInvokeResponse> ExecuteAsync(NodeInvokeRequest request) =>
        ExecuteAsync(request, CancellationToken.None);

    public async Task<NodeInvokeResponse> ExecuteAsync(
        NodeInvokeRequest request,
        CancellationToken cancellationToken)
    {
        try
        {
            if (!CanHandle(request.Command))
                return Error("canvas-command-denied: Canvas command is outside the Phase 1 allowlist.");
            var lease = activationLease.ValidateActive();
            var payload = await broker.ExecuteAsync(
                request.Command,
                request.Args,
                lease,
                activationLease,
                cancellationToken);
            return Success(payload ?? new { });
        }
        catch (HostPolicyException ex)
        {
            return Error($"{ex.Code}: {ex.Message}");
        }
        catch (OperationCanceledException)
        {
            return Error("canvas-cancelled: The Canvas invocation was cancelled.");
        }
        catch (Exception ex)
        {
            return Error($"canvas-failure: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private static NodeInvokeResponse Success(object payload) => new() { Ok = true, Payload = payload };
    private static NodeInvokeResponse Error(string error) => new() { Ok = false, Error = error };
}
