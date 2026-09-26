// Generic Inbound Webhook Gateway (Deno Deploy)
// (c) 2026 Hikaproj. All Rights Reserved.

import { finalizeEvent, generateSecretKey } from "https://esm.sh/nostr-tools@2.10.4/pure";
import * as nip04 from "https://esm.sh/nostr-tools@2.10.4/nip04";
import { Relay } from "https://esm.sh/nostr-tools@2.10.4/relay";

const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band"];
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";

Deno.serve(async (req: Request) => {
  // 1. プリフライト(OPTIONS)対応
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

  // 2. フロントエンドからの死活監視(GET)対応（CORSヘッダー必須）
  if (req.method === "GET") {
    return new Response(JSON.stringify({ status: "ok", gateway: "Deno Deploy Relay" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  // 3. Webhook受信(POST)処理
  if (req.method !== "POST") return new Response("Not Found", { status: 404 });

  try {
    const raw = await req.json();
    const data = raw.data || raw;
    const toRaw = Array.isArray(data.to) ? data.to[0] : (data.to || "");
    const match = toRaw.match(/([a-fA-F0-9]{64})/);

    if (!match) return new Response("Invalid Pubkey", { status: 400 });
    const recipientPubkey = match[1].toLowerCase();

    // 本文取得（Resend API連携）
    let emailText = data.text || "";
    let emailHtml = data.html || "";
    const emailId = data.email_id || data.id;

    if (emailId && RESEND_API_KEY && (!emailText && !emailHtml)) {
      try {
        const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
          headers: { "Authorization": `Bearer ${RESEND_API_KEY}` }
        });
        if (res.ok) {
          const detail = await res.json();
          emailText = detail.text || "";
          emailHtml = detail.html || "";
        }
      } catch (_) {}
    }

    const payload = {
      from: data.from || "unknown",
      to: toRaw,
      subject: data.subject || "(件名なし)",
      text: emailText || "(本文なし)",
      html: emailHtml || "",
      receivedAt: Date.now()
    };

    // 暗号化 & リレー配信
    const senderPrivKey = generateSecretKey();
    const ciphertext = await nip04.encrypt(senderPrivKey, recipientPubkey, JSON.stringify(payload));
    const signedEvent = finalizeEvent({
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", recipientPubkey]],
      content: ciphertext,
    }, senderPrivKey);

    const promises = RELAYS.map(async url => {
      try {
        const relay = await Relay.connect(url);
        await relay.publish(signedEvent);
        relay.close();
      } catch (_) {}
    });

    await Promise.allSettled(promises);

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (err: any) {
    return new Response(err.message, { status: 500 });
  }
});
