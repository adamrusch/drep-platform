#!/bin/bash
# Capture all surfaces — design and live — at desktop and mobile.
set -e
CHROME="/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
DESIGN_URL="http://localhost:8765/DRep%20Coordination%20Platform.html"
LIVE_BASE="https://drep.tools"
OUT="/Users/admin/Developer/drep-platform/.design-audit/visual"
SCRIPT="/Users/admin/Developer/drep-platform/.design-audit/cdp_shoot.js"

DESKTOP_W=1440
DESKTOP_H=900
MOBILE_W=390
MOBILE_H=844

# helper to click a sidebar item by visible label
click_nav() {
  local label="$1"
  echo "(() => { const btns = document.querySelectorAll('.nav__item'); for (const b of btns) { if (b.textContent.includes('$label')) { b.click(); break; } } })()"
}

# Click first governance action card (to navigate to proposal detail)
click_first_action() {
  echo "(async () => { const btns = document.querySelectorAll('.nav__item'); for (const b of btns) { if (b.textContent.includes('Governance Actions')) { b.click(); break; } } await new Promise(r => setTimeout(r, 800)); const card = document.querySelector('.action-card, .gov-card, [class*=\"GovCard\"], a[href*=\"action\"], button[class*=\"action\"]'); if (card) card.click(); else { const rows = document.querySelectorAll('article, .card, .row, [role=\"button\"]'); for (const r of rows) { if (r.textContent.match(/Treasury|Constitutional|Parameter/)) { r.click(); break; } } } })()"
}

theme_dark() {
  echo "document.documentElement.dataset.theme = 'dark';"
}

# ---------- DESIGN ----------

echo "=== DESIGN: Clubhouse (default landing of prototype, hero flow) ==="
node "$SCRIPT" "$CHROME" "$DESIGN_URL" "$OUT/01-clubhouse-design.png" $DESKTOP_W $DESKTOP_H 4000 ""

echo "=== DESIGN: Dashboard ==="
node "$SCRIPT" "$CHROME" "$DESIGN_URL" "$OUT/02-dashboard-design.png" $DESKTOP_W $DESKTOP_H 4000 "$(click_nav 'Dashboard')"

echo "=== DESIGN: Governance list ==="
node "$SCRIPT" "$CHROME" "$DESIGN_URL" "$OUT/03-governance-list-design.png" $DESKTOP_W $DESKTOP_H 4000 "$(click_nav 'Governance Actions')"

echo "=== DESIGN: Proposal detail ==="
node "$SCRIPT" "$CHROME" "$DESIGN_URL" "$OUT/04-proposal-detail-design.png" $DESKTOP_W $DESKTOP_H 4500 "$(click_first_action)"

echo "=== DESIGN: DReps profile ==="
node "$SCRIPT" "$CHROME" "$DESIGN_URL" "$OUT/05-drep-profile-design.png" $DESKTOP_W $DESKTOP_H 4000 "$(click_nav 'DReps')"

echo "=== DESIGN: Dark theme dashboard ==="
node "$SCRIPT" "$CHROME" "$DESIGN_URL" "$OUT/06-dashboard-dark-design.png" $DESKTOP_W $DESKTOP_H 4500 "(() => { document.documentElement.dataset.theme = 'dark'; const btns = document.querySelectorAll('.nav__item'); for (const b of btns) { if (b.textContent.includes('Dashboard')) { b.click(); break; } } })()"

echo "=== DESIGN: Mobile clubhouse ==="
node "$SCRIPT" "$CHROME" "$DESIGN_URL" "$OUT/07-clubhouse-design-mobile.png" $MOBILE_W $MOBILE_H 4000 ""

echo "=== DESIGN: Mobile governance list ==="
node "$SCRIPT" "$CHROME" "$DESIGN_URL" "$OUT/08-governance-design-mobile.png" $MOBILE_W $MOBILE_H 4000 "$(click_nav 'Governance Actions')"

# ---------- LIVE ----------

echo "=== LIVE: Landing ==="
node "$SCRIPT" "$CHROME" "$LIVE_BASE/" "$OUT/01-landing-live.png" $DESKTOP_W $DESKTOP_H 5000 ""

echo "=== LIVE: Governance list ==="
node "$SCRIPT" "$CHROME" "$LIVE_BASE/governance" "$OUT/03-governance-list-live.png" $DESKTOP_W $DESKTOP_H 5500 ""

echo "=== LIVE: Mobile landing ==="
node "$SCRIPT" "$CHROME" "$LIVE_BASE/" "$OUT/07-landing-live-mobile.png" $MOBILE_W $MOBILE_H 5000 ""

echo "=== LIVE: Mobile governance ==="
node "$SCRIPT" "$CHROME" "$LIVE_BASE/governance" "$OUT/08-governance-live-mobile.png" $MOBILE_W $MOBILE_H 5500 ""

echo "All captures done."
