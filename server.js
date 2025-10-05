import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import dotenv from "dotenv";
import fetch from "node-fetch";
import cors from "cors";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("Missing STRIPE_SECRET_KEY");
  process.exit(1);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// In-memory store (replace with Postgres/Supabase)
const merchants = new Map(); // key: account_id (acct_xxx), value: { access_token?, scope? }
const disputes = new Map();  // key: dispute_id, value: { data, draft, account_id }

// Use raw body for webhook signature verification
app.use("/webhooks/stripe", bodyParser.raw({ type: "*/*" }));
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

// --- Stripe Connect OAuth: Redirect to connect ---
app.get("/connect/stripe", (req, res) => {
  const client_id = process.env.STRIPE_CLIENT_ID;
  const redirect_uri = process.env.STRIPE_REDIRECT_URI;
  if (!client_id || !redirect_uri) {
    return res.status(500).json({ error: "Missing STRIPE_CLIENT_ID or STRIPE_REDIRECT_URI" });
  }
  const state = Math.random().toString(36).slice(2);
  const url = new URL("https://connect.stripe.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client_id);
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("redirect_uri", redirect_uri);
  // Optional: suggest capabilities
  url.searchParams.set("stripe_user[business_type]", "company");
  res.redirect(url.toString());
});

// --- OAuth callback: exchange code for tokens ---
app.get("/connect/stripe/callback", async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) return res.status(400).send(`OAuth error: ${error}: ${error_description}`);

  try {
    const token = await stripe.oauth.token({
      grant_type: "authorization_code",
      code: code
    });
    const account_id = token.stripe_user_id;
    merchants.set(account_id, { access_token: token.access_token, scope: token.scope });
    console.log("Connected account:", account_id);
    res.send(`✅ Connected Stripe account: ${account_id}. You can close this tab.`);
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth token exchange failed");
  }
});

// --- Webhook receiver ---
app.post("/webhooks/stripe", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_SIGNING_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Note: event.account contains the connected account id for Connect events
  const accountId = event.account || null;

  try {
    switch (event.type) {
      case "charge.dispute.created": {
        const dispute = event.data.object;
        console.log("🔔 Dispute created:", dispute.id, "acct:", accountId);
        // Retrieve full dispute from the connected account
        const full = await stripe.disputes.retrieve(dispute.id, accountId ? { stripeAccount: accountId } : {});

        // Generate AI draft
        const draft = await generateAIDraft(full);
        disputes.set(dispute.id, { data: full, draft, account_id: accountId || "platform" });

        break;
      }
      case "charge.dispute.closed": {
        const d = event.data.object;
        console.log("✅ Dispute closed:", d.id, "status:", d.status);
        break;
      }
      default:
        // ignore other events
        break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error("Webhook handler error:", e);
    res.status(500).send("Internal error");
  }
});

// List disputes we know about (demo)
app.get("/disputes", (req, res) => {
  const out = Array.from(disputes.entries()).map(([id, obj]) => ({
    id,
    account_id: obj.account_id,
    status: obj.data.status,
    amount: obj.data.amount,
    currency: obj.data.currency,
    reason: obj.data.reason,
    created: obj.data.created,
    draft: obj.draft?.slice(0, 400) + (obj.draft && obj.draft.length > 400 ? "..." : "")
  }));
  res.json(out);
});

// Manually submit the AI draft as evidence (MVP)
app.post("/disputes/:id/submit", async (req, res) => {
  const id = req.params.id;
  const rec = disputes.get(id);
  if (!rec) return res.status(404).json({ error: "Unknown dispute" });
  try {
    const evidence = {
      evidence: {
        uncategorized_text: rec.draft?.slice(0, 8000) || "See attached evidence."
      }
    };
    const updated = await stripe.disputes.update(id, evidence, rec.account_id && rec.account_id !== "platform" ? { stripeAccount: rec.account_id } : {});
    return res.json({ ok: true, updated });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to submit evidence", detail: e.message });
  }
});

async function generateAIDraft(dispute) {
  if (!process.env.OPENAI_API_KEY) {
    return `Dispute ${dispute.id}: Provide clear proof of service/delivery, customer communication, refund policy, and terms.\n(OPENAI_API_KEY missing; returning fallback text.)`;
  }
  const body = {
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: "You are a professional chargeback analyst. Draft a persuasive, structured dispute response. Use clear headings and cite attached evidence placeholders. Keep to ~250-350 words. Do not invent facts." },
      { role: "user", content: [
          `Dispute ID: ${dispute.id}`,
          `Reason: ${dispute.reason}`,
          `Amount: ${(dispute.amount/100).toFixed(2)} ${dispute.currency?.toUpperCase()}`,
          `Created: ${new Date(dispute.created*1000).toISOString()}`,
          `Charge: ${dispute.charge}`,
          `Evidence due by: ${dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by*1000).toISOString() : "unknown"}`,
          "",
          "Evidence available:",
          "- Order details: <attach order receipt / invoice>",
          "- Delivery/usage logs: <attach carrier delivery / tracking, access logs>",
          "- Customer comms: <attach email/chat transcripts>",
          "- Policies: <attach refund/terms/exclusions>",
          "",
          "Goal: Write a structured response addressing the cardholder's claim, referencing policy and proof, and requesting dispute reversal."
        ].join("\n")
      }
    ]
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  const content = json.choices?.[0]?.message?.content || "Draft unavailable.";
  return content;
}

app.listen(port, () => {
  console.log(`Dispute AI backend listening on http://localhost:${port}`);
  console.log(`→ Connect a merchant at http://localhost:${port}/connect/stripe`);
  console.log(`→ Set your Stripe webhook to POST http://localhost:${port}/webhooks/stripe`);
});
