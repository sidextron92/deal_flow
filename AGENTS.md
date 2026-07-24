<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

# Data model & DB tables

Before touching the cart or seller-resolution logic, read **`docs/DATA_MODEL.md`** —
it documents every `shoekonnect_live` table this project reads, how a
trader (FOS) → dark store (DS) → retailer-cart maps together, the two core queries
(seller resolution + cart), and the hard-won gotchas (e.g. match on `companyPhone`,
`status=0` only, seller derived from `fosId` not the token). deal_flow is read-only
against the DB.
<!-- END:nextjs-agent-rules -->
