// Aurimbox Relay Gateway (Deno Deploy)
// (c) 2026 Hikaproj. All Rights Reserved.

import { finalizeEvent, generateSecretKey } from "https://esm.sh/nostr-tools@2.10.4/pure";
import * as nip04 from "https://esm.sh/nostr-tools@2.10.4/nip04";
import { Relay } from "https://esm.sh/nostr-tools@2.10.4/relay";

const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.primal.net"
];

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";

Deno.serve(async (req: Request) => {
  // CORSプリフライト対応
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  const url = new URL(req.url);

  // ヘルスチェック用エンドポイント
  if (req.method === "GET") {
    return new Response(JSON.stringify({ status: "ok", app: "Aurimbox Gateway", time: new Date().toISOString() }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  if (url.pathname !== "/api/incoming" || req.method !== "POST") {
    return new Response("Not Found", { status: 404 });
  }

  try {
    const rawBody = await req.json();
    const data = rawBody.data || rawBody;

    // 宛先リストから 64文字HEX公開鍵 を探索
    let toCandidates: string[] = [];
    if (Array.isArray(data.to)) {
      toCandidates = data.to;
    } else if (typeof data.to === "string") {
      toCandidates = [data.to];
    }
    if (data.email) toCandidates.push(data.email);

    let recipientPubkey = "";
    let fullToAddress = "";

    for (const cand of toCandidates) {
      const match = cand.match(/([a-fA-F0-9]{64})/);
      if (match) {
        recipientPubkey = match[1].toLowerCase();
        fullToAddress = cand;
        break;
      }
    }

    if (!recipientPubkey) {
      console.warn("No valid 64-hex Nostr pubkey found in 'to':", toCandidates);
      return new Response(JSON.stringify({ error: "No valid 64-hex Nostr pubkey found in 'to' address." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Resendの仕様: 本文はAPI経由で取得が必要
    let emailText = data.text || "";
    let emailHtml = data.html || "";

    const emailId = data.email_id || data.id;
    if (emailId && RESEND_API_KEY && (!emailText && !emailHtml)) {
      try {
        const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
          headers: { "Authorization": `Bearer ${RESEND_API_KEY}` },
        });
        if (res.ok) {
          const detail = await res.json();
          emailText = detail.text || "";
          emailHtml = detail.html || "";
        }
      } catch (e) {
        console.error("Resend API Fetch Error:", e);
      }
    }

    // 本文が取得できなかった場合のフェイルセーフ
    if (!emailText && !emailHtml) {
      emailText = "(本文は暗号化通信または空です)";
    }

    // 中継用暗号化ペイロードの作成
    const payload = {
      from: data.from || "unknown@resend.app",
      to: fullToAddress,
      subject: data.subject || "(件名なし)",
      text: emailText,
      html: emailHtml,
      receivedAt: Date.now(),
    };

    // リレーサイズ制限対策（長大HTMLはカット）
    let serialized = JSON.stringify(payload);
    if (new TextEncoder().encode(serialized).length > 60000) {
      payload.html = "<p><em>[大容量メールのためHTML表示は省略されました。Text本文をご確認ください]</em></p>";
      serialized = JSON.stringify(payload);
    }

    // エフェメラル暗号化鍵生成（メモリ内破棄）
    const senderPrivKey = generateSecretKey();

    // NIP-04 暗号化
    const ciphertext = await nip04.encrypt(senderPrivKey, recipientPubkey, serialized);

    // Nostrイベント生成
    const eventTemplate = {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", recipientPubkey]],
      content: ciphertext,
    };
    const signedEvent = finalizeEvent(eventTemplate, senderPrivKey);

    // リレー送信（5秒タイムアウト付き）
    const publishPromises = RELAYS.map(async (relayUrl) => {
      let relay: Relay | null = null;
      try {
        const connectPromise = Relay.connect(relayUrl);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000));
        relay = await Promise.race([connectPromise, timeoutPromise]) as Relay;
        await relay.publish(signedEvent);
        return { relay: relayUrl, success: true };
      } catch (err) {
        return { relay: relayUrl, success: false };
      } finally {
        if (relay) {
          try { relay.close(); } catch (_) {}
        }
      }
    });

    const results = await Promise.allSettled(publishPromises);
    const sentCount = results.filter(r => r.status === "fulfilled" && (r.value as any).success).length;

    return new Response(JSON.stringify({ success: true, publishedRelays: sentCount, eventId: signedEvent.id }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error: any) {
    console.error("Relay Gateway Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});
