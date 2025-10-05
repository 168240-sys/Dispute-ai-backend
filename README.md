# Dispute AI Starter (Stripe Connect + Webhooks + OpenAI)

This is a ready-to-run MVP to compete with Justt-style dispute automation.

## What you get
- Stripe **Connect OAuth** (merchant clicks "Connect Stripe")  
- **Webhook** handler for `charge.dispute.created` / `charge.dispute.closed`  
- **OpenAI**-generated dispute response draft  
- **Submit** the draft as `uncategorized_text` evidence  
- Minimal DB schema (Postgres) you can wire later

## 0) Prereqs
- Node 18+
- A Stripe account (test mode)
- OpenAI API key (optional for local testing)

## 1) Configure env
Copy `.env.example` to `.env` and fill values:
- `STRIPE_CLIENT_ID` (Connect → OAuth)
- `STRIPE_SECRET_KEY` (sk_test_...)
- `STRIPE_SIGNING_SECRET` (from your webhook endpoint)
- `STRIPE_REDIRECT_URI` (e.g. http://localhost:3000/connect/stripe/callback)
- `OPENAI_API_KEY`

## 2) Install & run
```bash
npm install
npm run dev
```

## 3) Connect a merchant (test account)
Visit: `http://localhost:3000/connect/stripe`  
Complete Stripe OAuth → you'll see "Connected account: acct_...".

## 4) Webhooks
In Stripe Dashboard, add a webhook pointing to:  
`POST http://localhost:3000/webhooks/stripe`  
Subscribe to: `charge.dispute.created`, `charge.dispute.closed`.

**Local testing with Stripe CLI:**
```bash
stripe login
stripe listen --forward-to localhost:3000/webhooks/stripe
stripe trigger charge.dispute.created
```

## 5) Review disputes
Open: `http://localhost:3000/disputes` to see draft responses.

## 6) Submit evidence (MVP)
Call:
```bash
curl -X POST http://localhost:3000/disputes/dp_123/submit
```
This submits the AI draft under `evidence[uncategorized_text]`.

## Notes
- For Connect calls on a connected account, the server uses `stripe.disputes.retrieve(id, { stripeAccount: acct_xxx })`.
- Production: replace in-memory Maps with Postgres using `schema.sql`.
- Expand evidence fields over time (receipt, customer_communication, service_date, etc.).

## Roadmap
- Map AI output to structured Stripe evidence fields
- File uploads (S3) + attach file links
- Multi-processor (PayPal/Adyen)
- Merchant dashboard (Next.js or Framer)
- Shopify embedded app (GraphQL `ShopifyPaymentsDispute`)
