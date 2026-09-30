export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const ADMIN_KEY = "Dannyasd78"; // 管理員檢視密鑰
    
    // 寫死綁定代理 ID (更新為 JF5118)
    const HARDCODED_SUPERID = "JF5118";
    const HARDCODED_INTRODUCER = "JF5118";
    const DEFAULT_BASE_URL = "https://www.osc168.com/";

    // 1. 自動初始化 D1 資料表
    try {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value TEXT);").run();
    } catch (e) {}

    // D1 操作封裝函式
    async function dbGet(k) {
      try {
        const row = await env.DB.prepare("SELECT value FROM stats WHERE key = ?").bind(k).first();
        return row ? row.value : null;
      } catch (e) { return null; }
    }

    async function dbPut(k, v) {
      try {
        await env.DB.prepare("INSERT INTO stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(v)).run();
      } catch (e) {}
    }

    // 強制雙重鎖定綁定網址產生器（? 與 # 同時植入，防止 App 剝離）
    function buildLockedTargetUrl(rawUrl) {
      let targetBase = rawUrl || DEFAULT_BASE_URL;
      try {
        // 先切開原有 Hash
        let [cleanUrl, rawHash] = targetBase.split("#");
        let u = new URL(cleanUrl);
        
        // 1. 於 URL SearchParams 強制寫入參數
        u.searchParams.set("superid", HARDCODED_SUPERID);
        u.searchParams.set("introducer", HARDCODED_INTRODUCER);

        // 2. 於 Hash 路由強制寫入參數
        let hashRoute = rawHash ? rawHash.split("?")[0] : "/";
        if (!hashRoute.startsWith("/")) hashRoute = "/" + hashRoute;

        return `${u.toString()}#${hashRoute}?superid=${HARDCODED_SUPERID}&introducer=${HARDCODED_INTRODUCER}`;
      } catch (e) {
        return `https://www.osc168.com/?superid=${HARDCODED_SUPERID}&introducer=${HARDCODED_INTRODUCER}#/?superid=${HARDCODED_SUPERID}&introducer=${HARDCODED_INTRODUCER}`;
      }
    }

    // 2. 識別訪客國家與真實 IP
    const country = (request.cf && request.cf.country) ? request.cf.country.toUpperCase() : "UNKNOWN";
    const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "";

    // 取得台灣時間 (UTC+8) 指定位移天數的日期字串 (YYYY-MM-DD)
    function getDateStr(offsetDays = 0) {
      const d = new Date(Date.now() + 8 * 3600 * 1000 - offsetDays * 86400 * 1000);
      return d.toISOString().split("T")[0];
    }

    // 全球國家 ISO 碼轉換為國旗 Emoji + 繁體中文名稱
    const regionNames = new Intl.DisplayNames(['zh-TW'], { type: 'region' });
    function getCountryLabel(code) {
      if (code === "UNKNOWN" || !code) return "🌐 未知地區";
      try {
        const flag = code.replace(/./g, char => String.fromCodePoint(127397 + char.charCodeAt(0)));
        const name = regionNames.of(code) || code;
        return `${flag} ${name}`;
      } catch (e) {
        return `🌐 ${code}`;
      }
    }

    // 取得目標原始網址，並通過防脫綁引擎轉換
    let storedTargetUrl = (await dbGet("target_url")) || DEFAULT_BASE_URL;
    let finalTargetUrl = buildLockedTargetUrl(storedTargetUrl);

    let excludedIpsRaw = (await dbGet("excluded_ips")) || "";
    let excludedIps = excludedIpsRaw.split(",").map(ip => ip.trim()).filter(Boolean);

    // -------------------------------------------------------------
    // 管理員模式 (?key=Dannyasd78)
    // -------------------------------------------------------------
    if (key === ADMIN_KEY) {
      let statusMessage = "";

      // 自動將目前管理員的 IP 加入隔離名單
      if (clientIp && !excludedIps.includes(clientIp)) {
        excludedIps.push(clientIp);
        await dbPut("excluded_ips", excludedIps.join(","));
        statusMessage = `📍 已自動將您的目前 IP (${clientIp}) 加入隔離名單！`;
      }

      // 處理表單提交 (POST)
      if (request.method === "POST") {
        try {
          const formData = await request.formData();
          const action = formData.get("action");

          if (action === "update_url") {
            const newUrl = formData.get("new_target_url");
            if (newUrl && newUrl.startsWith("http")) {
              await dbPut("target_url", newUrl.trim());
              storedTargetUrl = newUrl.trim();
              finalTargetUrl = buildLockedTargetUrl(storedTargetUrl);
              statusMessage = "✅ 目標網址已成功更新並強制鎖定代理參數！";
            } else {
              statusMessage = "❌ 請輸入有效的完整網址（需包含 http:// 或 https://）";
            }
          } else if (action === "update_ips") {
            const newIps = formData.get("excluded_ips_input") || "";
            excludedIps = newIps.split(",").map(ip => ip.trim()).filter(Boolean);
            await dbPut("excluded_ips", excludedIps.join(","));
            statusMessage = "✅ 隔離 IP 名單已手動更新！";
          } else if (action === "reset_stats") {
            await env.DB.prepare("DELETE FROM stats WHERE key NOT IN ('target_url', 'excluded_ips')").run();
            statusMessage = "🗑️ 所有訪客流量數據已成功清空歸零！";
          }
        } catch (e) {
          statusMessage = "❌ 操作失敗，請重新嘗試";
        }
      }

      const today = getDateStr(0);
      const dateKeys = Array.from({ length: 30 }, (_, i) => `count:${getDateStr(i)}`);

      const [
        totalRaw, totalUvRaw, totalRvRaw,
        todayTotalRaw, todayUvRaw, todayRvRaw,
        countriesRaw,
        ...dailyRaw
      ] = await Promise.all([
        dbGet("count"),
        dbGet("count_uv"),
        dbGet("count_rv"),
        dbGet(`count:${today}`),
        dbGet(`count_uv:${today}`),
        dbGet(`count_rv:${today}`),
        dbGet("count_countries"),
        ...dateKeys.map(k => dbGet(k))
      ]);

      const totalCount = parseInt(totalRaw || "0", 10);
      const totalUv = parseInt(totalUvRaw || "0", 10);
      const totalRv = parseInt(totalRvRaw || "0", 10);

      const todayTotal = parseInt(todayTotalRaw || "0", 10);
      const todayUv = parseInt(todayUvRaw || "0", 10);
      const todayRv = parseInt(todayRvRaw || "0", 10);

      const dailyCounts = dailyRaw.map(v => parseInt(v || "0", 10));
      const last7Count = dailyCounts.slice(0, 7).reduce((a, b) => a + b, 0);
      const last30Count = dailyCounts.reduce((a, b) => a + b, 0);

      // 解析全球各國訪問數據並自動降序排序
      let countriesObj = {};
      try {
        countriesObj = JSON.parse(countriesRaw || "{}");
      } catch (e) {}

      const sortedCountries = Object.entries(countriesObj).sort((a, b) => b[1] - a[1]);
      const isCurrentIpExcluded = excludedIps.includes(clientIp);

      // 產生全球國家列表 HTML
      let countryListHtml = "";
      if (sortedCountries.length === 0) {
        countryListHtml = `<div style="color:#a0aec0; font-size:13px; text-align:center; padding:10px;">尚無全球造訪數據</div>`;
      } else {
        countryListHtml = sortedCountries.map(([code, count]) => {
          const percent = totalCount > 0 ? ((count / totalCount) * 100).toFixed(1) : "0.0";
          return `
            <div class="country-row">
              <span class="country-name">${getCountryLabel(code)}</span>
              <span class="country-count"><strong>${count}</strong> 次 (${percent}%)</span>
            </div>
          `;
        }).join("");
      }

      const adminHtml = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>管理員數據面板 (雙重鎖定防脫綁)</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; background: #f4f6f9; display: flex; justify-content: center; align-items: center; min-height: 90vh; margin: 0; }
    .card { padding: 25px; border-radius: 12px; background: #ffffff; width: 100%; max-width: 480px; box-shadow: 0 4px 15px rgba(0,0,0,0.08); text-align: center; }
    h3 { margin: 0 0 5px 0; color: #2d3748; }
    .subtitle { color: #718096; margin: 0 0 12px 0; font-size: 13px; }
    .ip-badge { display: inline-block; background: #edf2f7; color: #2d3748; font-size: 12px; font-weight: bold; padding: 6px 12px; border-radius: 20px; margin-bottom: 15px; }
    .ip-badge.isolated { background: #feebc8; color: #744210; border: 1px solid #fbd38d; }
    .section-title { font-size: 14px; font-weight: bold; color: #4a5568; text-align: left; margin: 15px 0 8px 0; padding-left: 6px; border-left: 3px solid #3182ce; }
    .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 10px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
    .stat-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 6px; text-align: center; }
    .stat-label { font-size: 12px; color: #64748b; margin-bottom: 4px; font-weight: 500; }
    .stat-value { font-size: 18px; font-weight: bold; color: #1e293b; }
    .stat-box.highlight { background: #fef2f2; border-color: #fecaca; }
    .stat-box.highlight .stat-value { color: #dc2626; }
    .stat-box.blue { background: #ebf8ff; border-color: #bee3f8; }
    .stat-box.blue .stat-value { color: #2b6cb0; }
    .stat-box.green { background: #f0fff4; border-color: #c6f6d5; }
    .stat-box.green .stat-value { color: #2f855a; }
    .country-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 14px; margin-bottom: 10px; max-height: 220px; overflow-y: auto; text-align: left; }
    .country-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px dashed #e2e8f0; font-size: 13px; }
    .country-row:last-child { border-bottom: none; }
    .country-name { font-weight: 600; color: #2d3748; }
    .country-count { color: #4a5568; }
    .form-group { margin-top: 15px; text-align: left; }
    label { font-size: 13px; font-weight: bold; color: #333; display: block; margin-bottom: 6px; }
    input[type="url"], input[type="text"] { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 13px; }
    button { width: 100%; margin-top: 8px; padding: 10px; background: #3182ce; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: bold; cursor: pointer; }
    button:hover { background: #2b6cb0; }
    .btn-danger { background: #e53e3e !important; }
    .btn-danger:hover { background: #c53030 !important; }
    .msg { margin-top: 12px; font-size: 13px; font-weight: bold; color: #2b6cb0; }
    .url-preview { background: #edf2f7; padding: 8px; border-radius: 6px; font-size: 11px; word-break: break-all; color: #2d3748; margin-top: 6px; text-align: left; }
    a { display: inline-block; margin-top: 15px; color: #3182ce; text-decoration: none; font-weight: bold; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h3>⚙️ 管理員數據面板</h3>
    <p class="subtitle">(雙重鎖定代理參數：JF5118 100% 不脫綁)</p>

    <div class="ip-badge ${isCurrentIpExcluded ? 'isolated' : ''}">
      📍 您目前的 IP：<strong>${clientIp || '未知'}</strong> 
      ${isCurrentIpExcluded ? '🛡️ (已隔離，造訪不計數)' : '⚠️ (未隔離)'}
    </div>

    <div class="section-title">📅 當日即時流量</div>
    <div class="grid-3">
      <div class="stat-box highlight">
        <div class="stat-label">當日總造訪</div>
        <div class="stat-value">${todayTotal} 次</div>
      </div>
      <div class="stat-box blue">
        <div class="stat-label">不重複(新客)</div>
        <div class="stat-value">${todayUv} 人</div>
      </div>
      <div class="stat-box green">
        <div class="stat-label">重複(回訪)</div>
        <div class="stat-value">${todayRv} 次</div>
      </div>
    </div>

    <div class="section-title">🌍 全球國家/地區流量 (${sortedCountries.length} 個國家)</div>
    <div class="country-box">
      ${countryListHtml}
    </div>

    <div class="section-title">🌐 歷史累積流量</div>
    <div class="grid-3">
      <div class="stat-box">
        <div class="stat-label">歷史總造訪</div>
        <div class="stat-value">${totalCount} 次</div>
      </div>
      <div class="stat-box blue">
        <div class="stat-label">不重複(新客)</div>
        <div class="stat-value">${totalUv} 人</div>
      </div>
      <div class="stat-box green">
        <div class="stat-label">重複(回訪)</div>
        <div class="stat-value">${totalRv} 次</div>
      </div>
    </div>

    <div class="section-title">📈 趨勢指標</div>
    <div class="grid-2">
      <div class="stat-box">
        <div class="stat-label">7 日累積造訪</div>
        <div class="stat-value">${last7Count} 次</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">30 日累積造訪</div>
        <div class="stat-value">${last30Count} 次</div>
      </div>
    </div>

    <hr style="border: 0; border-top: 1px solid #edf2f7; margin: 20px 0;">

    <form method="POST" action="?key=${ADMIN_KEY}" onsubmit="return confirm('⚠️ 確定要更新目標網址嗎？系統將自動強制綁定 JF5118 參數！');">
      <input type="hidden" name="action" value="update_url">
      <div class="form-group">
        <label for="new_target_url">🎯 動態修改跳轉目標網址：</label>
        <input type="url" id="new_target_url" name="new_target_url" value="${storedTargetUrl}" required placeholder="https://...">
      </div>
      <div class="url-preview">
        <strong>🔒 最終鎖定跳轉網址：</strong><br>${finalTargetUrl}
      </div>
      <button type="submit">儲存全新網址</button>
    </form>

    <form method="POST" action="?key=${ADMIN_KEY}" style="margin-top: 15px;">
      <input type="hidden" name="action" value="update_ips">
      <div class="form-group">
        <label for="excluded_ips_input">🛡️ 隔離 IP 清單 (多個用逗號分隔)：</label>
        <input type="text" id="excluded_ips_input" name="excluded_ips_input" value="${excludedIps.join(', ')}" placeholder="1.2.3.4, 5.6.7.8">
      </div>
      <button type="submit" style="background: #4a5568;">儲存 IP 隔離清單</button>
    </form>

    <form method="POST" action="?key=${ADMIN_KEY}" style="margin-top: 20px;" onsubmit="return confirm('⚠️ 確定要清空歸零所有訪客數據嗎？此操作無法復原！');">
      <input type="hidden" name="action" value="reset_stats">
      <button type="submit" class="btn-danger">🗑️ 一鍵清空歸零所有數據</button>
    </form>

    ${statusMessage ? `<div class="msg">${statusMessage}</div>` : ""}

    <a href="${finalTargetUrl}" target="_blank">點此測試造訪目前目標頁面 →</a>
  </div>
</body>
</html>`;

      return new Response(adminHtml, {
        headers: { "content-type": "text/html;charset=UTF-8" }
      });
    }

    // -------------------------------------------------------------
    // 機器人 / 爬蟲識別 & IP 隔離檢查
    // -------------------------------------------------------------
    const userAgent = (request.headers.get("user-agent") || "").toLowerCase();
    const isBot = /bot|crawler|spider|facebookexternalhit|telegrambot|whatsapp|twitterbot|slackbot|discordbot|curl|wget|python|headless/i.test(userAgent);
    const isExcludedIp = clientIp && excludedIps.includes(clientIp);

    // -------------------------------------------------------------
    // 真實訪客計數邏輯
    // -------------------------------------------------------------
    const cookieHeader = request.headers.get("cookie") || "";
    const isRepeat = cookieHeader.includes("visited_osc168=1");

    if (!isBot && !isExcludedIp) {
      const today = getDateStr(0);

      try {
        const [
          totalRaw, totalTypeRaw,
          todayTotalRaw, todayTypeRaw,
          countriesRaw
        ] = await Promise.all([
          dbGet("count"),
          dbGet(isRepeat ? "count_rv" : "count_uv"),
          dbGet(`count:${today}`),
          dbGet(isRepeat ? `count_rv:${today}` : `count_uv:${today}`),
          dbGet("count_countries")
        ]);

        const newTotal = parseInt(totalRaw || "0", 10) + 1;
        const newTotalType = parseInt(totalTypeRaw || "0", 10) + 1;
        const newTodayTotal = parseInt(todayTotalRaw || "0", 10) + 1;
        const newTodayType = parseInt(todayTypeRaw || "0", 10) + 1;

        let countriesObj = {};
        try { countriesObj = JSON.parse(countriesRaw || "{}"); } catch (e) {}
        countriesObj[country] = (countriesObj[country] || 0) + 1;

        const typeKey = isRepeat ? "count_rv" : "count_uv";
        const todayTypeKey = isRepeat ? `count_rv:${today}` : `count_uv:${today}`;

        await Promise.all([
          dbPut("count", newTotal.toString()),
          dbPut(typeKey, newTotalType.toString()),
          dbPut(`count:${today}`, newTodayTotal.toString()),
          dbPut(todayTypeKey, newTodayType.toString()),
          dbPut("count_countries", JSON.stringify(countriesObj))
        ]);
      } catch (e) {}
    }

    // -------------------------------------------------------------
    // 極速 302 重定向跳轉 (使用防脫綁 finalTargetUrl)
    // -------------------------------------------------------------
    const headers = new Headers();
    headers.set("Location", finalTargetUrl);

    if (!isBot && !isExcludedIp && !isRepeat) {
      headers.set("Set-Cookie", "visited_osc168=1; Max-Age=31536000; Path=/; SameSite=Lax; Secure");
    }

    return new Response(null, {
      status: 302,
      headers: headers
    });
  }
};
