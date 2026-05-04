# Tebex DayZ Webhook

Endpoint:
`POST /tebex`

Health check:
`GET /`

Required Railway variables:
ZAP_HOST
ZAP_PORT
ZAP_USER
ZAP_PASS
BANK_DIR
BANK_KEY
WEBHOOK_SECRET or TEBEX_WEBHOOK_SECRET

Notes:
- This edits `/VirtualBank/<SteamID64>.json`
- Package names must contain: `2,500 Coins`, `5,000 Coins`, `10,000 Coins`, or `25,000 Coins`
