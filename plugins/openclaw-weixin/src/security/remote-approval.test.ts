import { describe, expect, it, vi } from "vitest";

vi.mock("../messaging/inbound.js", () => ({ getContextToken: vi.fn() }));
vi.mock("../messaging/send.js", () => ({ sendMessageWeixin: vi.fn() }));

import { MessageItemType, MessageType, type WeixinMessage } from "../api/types.js";
import {
  classifyWeixinRemoteApprovalCandidate,
  normalizeInboundSource,
  WeixinRemoteApprovalTransport,
} from "./remote-approval.js";

function message(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    seq: 42,
    message_id: 1001,
    from_user_id: "OWNER@IM.WECHAT",
    to_user_id: "BOT@IM.WECHAT",
    message_type: MessageType.USER,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: "1 23456789" } }],
    ...overrides,
  };
}

describe("WeChat remote approval ingress normalization", () => {
  it("normalizes exact authenticated direct-chat identity fields", () => {
    expect(
      normalizeInboundSource(
        message(),
        "BOT@IM.WECHAT",
        "main",
        "agent:main:weixin:owner",
      ),
    ).toMatchObject({
      accountId: "bot@im.wechat",
      senderId: "OWNER@IM.WECHAT",
      conversationId: "OWNER@IM.WECHAT",
      messageId: "1001",
      cursor: "42",
      agentId: "main",
      sessionKey: "agent:main:weixin:owner",
      direct: true,
      forwarded: false,
      quoted: false,
      text: "1 23456789",
    });
  });

  it("preserves exact canonical decimal provider strings without Number conversion", () => {
    expect(normalizeInboundSource(
      message({ message_id: "18446744073709551000", seq: "9007199254740993" }),
      "bot", "main", "s",
    )).toMatchObject({ messageId: "18446744073709551000", cursor: "9007199254740993" });
  });

  it("marks group, forwarded, and quoted forms as ineligible", () => {
    expect(normalizeInboundSource(message({ group_id: "group-1" }), "bot", "main", "s")).toMatchObject({
      direct: false,
    });
    expect(
      normalizeInboundSource(
        message({ message_type: MessageType.BOT }),
        "bot",
        "main",
        "s",
      ),
    ).toMatchObject({ forwarded: true, direct: false });
    expect(
      normalizeInboundSource(
        message({
          item_list: [
            {
              type: MessageItemType.TEXT,
              text_item: { text: "1 23456789" },
              ref_msg: { title: "forwarded approval" },
            },
          ],
        }),
        "bot",
        "main",
        "s",
      ),
    ).toMatchObject({ quoted: true });
  });

  it("does not normalize mixed or split content into an approval reply", () => {
    expect(
      normalizeInboundSource(
        message({
          item_list: [
            { type: MessageItemType.TEXT, text_item: { text: "1 " } },
            { type: MessageItemType.TEXT, text_item: { text: "23456789" } },
          ],
        }),
        "bot",
        "main",
        "s",
      ),
    ).toMatchObject({ text: "" });
  });

  it("preserves exact text and classifies exact, mixed, malformed, and ordinary replies", () => {
    expect(classifyWeixinRemoteApprovalCandidate(message())).toEqual({
      candidateLike: true,
      ambiguous: false,
      text: "1 23456789",
    });
    expect(
      classifyWeixinRemoteApprovalCandidate(
        message({
          item_list: [
            { type: MessageItemType.TEXT, text_item: { text: "prefix 1 23456789 suffix" } },
          ],
        }),
      ),
    ).toEqual({
      candidateLike: true,
      ambiguous: true,
      text: "prefix 1 23456789 suffix",
    });
    expect(
      classifyWeixinRemoteApprovalCandidate(
        message({
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: "1-2345678" } }],
        }),
      ),
    ).toEqual({
      candidateLike: true,
      ambiguous: true,
      text: "1-2345678",
    });
    for (const text of ["1", "2", "3"]) {
      expect(
        classifyWeixinRemoteApprovalCandidate(
          message({
            item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
          }),
        ),
      ).toEqual({ candidateLike: true, ambiguous: false, text });
    }
    expect(
      classifyWeixinRemoteApprovalCandidate(
        message({
          item_list: [
            { type: MessageItemType.TEXT, text_item: { text: "1" } },
            { type: MessageItemType.IMAGE },
          ],
        }),
      ),
    ).toEqual({ candidateLike: true, ambiguous: true, text: "1" });
    expect(
      normalizeInboundSource(
        message({
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: " 1 23456789 " } }],
        }),
        "bot",
        "main",
        "s",
      ),
    ).toMatchObject({ text: " 1 23456789 " });
  });

  it("rejects ambiguous identity, cursor, message, agent, and session forms", () => {
    expect(normalizeInboundSource(message({ from_user_id: "display name" }), "bot", "main", "s")).toBeNull();
    expect(normalizeInboundSource(message({ seq: undefined }), "bot", "main", "s")).toBeNull();
    expect(
      normalizeInboundSource(message({ message_id: undefined }), "bot", "main", "s"),
    ).toBeNull();
    expect(normalizeInboundSource(message(), "bot", "", "s")).toBeNull();
    expect(normalizeInboundSource(message(), "bot", "main", "")).toBeNull();
  });

  it("makes monitor-generation transport shutdown terminal", () => {
    const previousPipe = process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_PIPE;
    const previousToken = process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_TOKEN;
    process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_PIPE = "\\\\.\\pipe\\test";
    process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_TOKEN = "token";
    try {
      const transport = new WeixinRemoteApprovalTransport({
        accountId: "bot@im.wechat",
        baseUrl: "https://weixin.test",
      });
      expect(transport.enabled).toBe(true);
      transport.close();
      expect(transport.enabled).toBe(false);
    } finally {
      if (previousPipe === undefined) delete process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_PIPE;
      else process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_PIPE = previousPipe;
      if (previousToken === undefined) delete process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_TOKEN;
      else process.env.MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_TOKEN = previousToken;
    }
  });
});
