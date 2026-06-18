#!/bin/bash

# Example: Using puppeteer-server to scrape SAP API Hub
#
# Prerequisites:
# 1. Start the server: node ../index.js --url https://api.sap.com
# 2. Log in to your SAP account in the browser
# 3. Press ENTER to start the server
# 4. Run this script

BASE_URL="http://localhost:3000"

echo "=== SAP API Hub Scraping Examples ==="
echo

# 1. Get current page info
echo "1. Getting current page info..."
curl -s "$BASE_URL/page" | jq .
echo

# 2. Navigate to a specific API
echo "2. Navigating to Business Partner API..."
curl -s -X POST "$BASE_URL/goto" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://api.sap.com/api/API_BUSINESS_PARTNER/overview"}' | jq .
echo

# 3. Extract API title from page
echo "3. Extracting API title..."
curl -s -X POST "$BASE_URL/run" \
  -H "Content-Type: application/json" \
  -d '{"code": "return await page.title()"}' | jq .
echo

# 4. Get all API metadata using the OData endpoint
echo "4. Fetching API metadata via authenticated session..."
curl -s -X POST "$BASE_URL/run" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "await page.goto(\"https://api.sap.com/odata/1.0/catalog.svc/APIContent.APIs('\\''API_BUSINESS_PARTNER'\\'')?$select=*&$format=json\", { waitUntil: \"networkidle2\" }); return await helpers.getJson();"
  }' | jq .
echo

# 5. Download OpenAPI spec
echo "5. Downloading OpenAPI specification..."
curl -s -X POST "$BASE_URL/run" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "await page.goto(\"https://api.sap.com/odata/1.0/catalog.svc/APIContent.APIs('\\''API_BUSINESS_PARTNER'\\'')/\\$value?type=json\", { waitUntil: \"networkidle2\" }); return await helpers.getJson();"
  }' | jq '.info.title, .info.version'
echo

echo "=== Done ==="
