// Aurimbox Relay Gateway (Deno Deploy)
// (c) 2026 Hikaproj. All Rights Reserved.

import { finalizeEvent, generateSecretKey } from "npm:nostr-tools@2.7.2/pure";
import * as nip04 from "npm:nostr-tools@2.7.2/nip04";
import { Relay } from "npm:nostr-tools@2.7.2/relay";

const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band"
];

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  const url = new URL(req.url);
  if (url.pathname !== "/api/incoming" || req.method !== "POST") {
    return new Response("Aurimbox Gateway is Active.", { status: 200 });
  }

  try {
    const rawBody = await req.json();
    const data = rawBody.data || rawBody;

    // ResendのTo宛先からアドレス抽出
    const toRaw = Array.isArray(data.to) ? data.to[0] : (data.to || "");
    const emailMatch = toRaw.match(/([a-fA-F0-9]{64})@/);

    if (!emailMatch) {
      console.warn("Invalid recipient pubkey format:", toRaw);
      return new Response(JSON.stringify({ error: "Invalid recipient public key." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const recipientPubkey = emailMatch[1].toLowerCase();

    // Resend Inbound仕様: 本文(text/html)をAPI経由で取得
    let emailText = data.text || "";
    let emailHtml = data.html || "";

    const emailId = data.email_id || data.id;
    if (emailId && RESEND_API_KEY && (!emailText && !emailHtml)) {
      try {
        const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
          headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
          },
        });
        if (res.ok) {
          const detail = await res.json();
          emailText = detail.text || "";
          emailHtml = detail.html || "";
        }
      } catch (fetchErr) {
        console.error("Error fetching email detail from Resend:", fetchErr);
      }
    }

    // 暗号化対象ペイロードの構築
    const payload = {
      from: data.from || "unknown",
      to: toRaw,
      subject: data.subject || "(No Subject)",
      text: emailText,
      html: emailHtml,
      receivedAt: Date.now(),
    };

    // リレーサイズ制限対策（長大HTMLはカットしてプレーンテキストを優先）
    let serialized = JSON.stringify(payload);
    if (new TextEncoder().encode(serialized).length > 60000) {
      payload.html = "<p><em>[本文が大容量のためHTMLプレビューは省略されました。Text本文をご確認ください]</em></p>";
      serialized = JSON.stringify(payload);
    }

    // 中継用エフェメラル送信鍵の生成（メモリ上のみ、完全ステートレス）
    const senderPrivKey = generateSecretKey();

    // NIP-04 暗号化
    const ciphertext = await nip04.encrypt(senderPrivKey, recipientPubkey, serialized);

    // Nostrイベント (Kind: 4) の作成・署名
    const eventTemplate = {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", recipientPubkey]],
      content: ciphertext,
    };
    const signedEvent = finalizeEvent(eventTemplate, senderPrivKey);

    // パブリックリレーへ並列Publish
    const publishPromises = RELAYS.map(async (relayUrl) => {
      try {
        const relay = await Relay.connect(relayUrl);
        await relay.publish(signedEvent);
        relay.close();
      } catch (err) {
        console.error(`Publish failed for ${relayUrl}:`, err);
      }
    });

    await Promise.allSettled(publishPromises);

    return new Response(JSON.stringify({ success: true, eventId: signedEvent.id }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("Relay processing error:", error);
    return new Response(JSON.stringify({ error: "Internal processing error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});
