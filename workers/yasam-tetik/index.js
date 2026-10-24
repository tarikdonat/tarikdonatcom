const SAAT_MODU = { "0 5,17 * * *": { 5: "sabah", 17: "aksam" }, "0 16 * * SUN": { 16: "hafta" }, "0 6,13 * * *": { 6: "ders_sabah", 13: "ders_ikindi" } };

async function tetikle(env, workflow, inputs) {
  let son = "";
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`https://api.github.com/repos/tarikdonat/yasam-takip/actions/workflows/${workflow}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "yasam-tetik",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    });
    if (r.status === 204) return true;
    son = `${r.status} ${(await r.text()).slice(0, 150)}`;
    console.error("dispatch başarısız", i + 1, son);
    await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
  }
  if (env.BOT_TOKEN) {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.CHAT_ID, text: `⚠️ ${workflow} tetiklenemedi: ${son}` }),
    });
  }
  return false;
}


const API = "https://api.github.com/repos/tarikdonat/yasam-takip/actions";
const gh = (env, path) => fetch(API + path, { headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "yasam-tetik", "X-GitHub-Api-Version": "2022-11-28" } });
const saat = (iso) => new Date(iso).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

async function telegram(env, text) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.CHAT_ID, text }),
  });
}

async function sonCalismalar(env, workflow, n) {
  const r = await gh(env, `/workflows/${workflow}/runs?per_page=${n}`);
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return (await r.json()).workflow_runs;
}

const isaret = (x) => (x.status !== "completed" ? "⏳" : x.conclusion === "success" ? "✅" : "❌");

async function durum(env) {
  const satirlar = ["🔎 Sistem durumu"];
  for (const [ad, wf, n] of [["Brief", "brief.yml", 4], ["Soru-cevap", "soru.yml", 2]]) {
    try {
      const k = await sonCalismalar(env, wf, n);
      satirlar.push("", `${ad}:`, ...(k.length ? k.map((x) => `${isaret(x)} ${saat(x.created_at)} (${x.event === "workflow_dispatch" ? "tetik" : x.event})`) : ["(çalışma yok)"]));
    } catch (e) {
      satirlar.push("", `${ad}: ❌ GitHub okunamadı (${e.message})`);
    }
  }
  satirlar.push("", "Zamanlama (Cloudflare): sabah 08:00 (Cmt ve Pazar yok), akşam 20:00 (Cmt yok), Pazar 19:00 haftalık; kontrol +10 dk.");
  await telegram(env, satirlar.join(String.fromCharCode(10)));
  await tetikle(env, "saglik.yml", {});
}

async function webhookOnar(env) {
  if (!env.WEBHOOK_URL || !env.BOT_TOKEN) return;
  const b = `https://api.telegram.org/bot${env.BOT_TOKEN}`;
  const bilgi = (await (await fetch(`${b}/getWebhookInfo`)).json()).result || {};
  if (bilgi.url === env.WEBHOOK_URL && (bilgi.allowed_updates || []).includes("callback_query")) return;
  const r = await (await fetch(`${b}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: env.WEBHOOK_URL, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] }),
  })).json();
  await telegram(env, r.ok
    ? (bilgi.url === env.WEBHOOK_URL ? "🔧 Telegram webhook izinleri güncellendi (ödeme butonları açıldı)." : `🔧 Telegram webhook'u ${bilgi.url ? "başka bir adrese çevrilmişti" : "silinmişti"}; otomatik yeniden kurdum (bekleyen mesaj: ${bilgi.pending_update_count ?? 0}).`)
    : `⚠️ Telegram webhook'u onarılamadı: ${JSON.stringify(r).slice(0, 150)}`);
}

// Cumartesi sabah+akşam ve Pazar sabah brief yok; Pazar akşamı gelir (UTC günü TR günüyle aynı: 05:00 ve 17:00 UTC)
function brifAtla(mode, zaman) {
  const gun = new Date(zaman).getUTCDay();
  return (mode === "sabah" && (gun === 0 || gun === 6)) || (mode === "aksam" && gun === 6);
}

async function bekci(env, event) {
  const utcSaat = new Date(event.scheduledTime).getUTCHours();
  const mode = utcSaat === 5 ? "sabah" : utcSaat === 17 ? "aksam" : "hafta";
  if (brifAtla(mode, event.scheduledTime)) return;
  const k = await sonCalismalar(env, "brief.yml", 5);
  const yeni = k.filter((x) => Date.now() - new Date(x.created_at).getTime() < 25 * 60 * 1000);
  if (!yeni.length) {
    const ok = await tetikle(env, "brief.yml", { mode });
    await telegram(env, `⏱ ${mode} brief zamanında başlamamıştı; ${ok ? "yeniden tetikledim." : "yeniden tetikleme de başarısız."}`);
  } else if (yeni.some((x) => x.status === "completed" && x.conclusion !== "success")) {
    await telegram(env, `❌ ${mode} brief çalıştı ama hata verdi (${saat(yeni[0].created_at)}). GitHub Actions kaydına bak.`);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/telegram") return new Response("yok", { status: 404 });
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("yok", { status: 404 });
    const upd = await req.json();
    if (upd.callback_query) {  // 'Ödendi mi?' butonları
      const cb = upd.callback_query;
      const b = `https://api.telegram.org/bot${env.BOT_TOKEN}`;
      const post = (yol, govde) => fetch(`${b}/${yol}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(govde) });
      if (cb.message && String(cb.message.chat.id) === String(env.CHAT_ID) && typeof cb.data === "string" && cb.data.startsWith("od|")) {
        await post("answerCallbackQuery", { callback_query_id: cb.id, text: "İşleniyor…" });
        const kalan = cb.data === "od|hepsi" ? [] : ((cb.message.reply_markup && cb.message.reply_markup.inline_keyboard) || []).map((r) => r.filter((x) => x.callback_data !== cb.data)).filter((r) => r.length);
        await post("editMessageReplyMarkup", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: kalan } });
        await tetikle(env, "soru.yml", { question: "__ode__|" + cb.data.slice(3) });
      } else {
        await post("answerCallbackQuery", { callback_query_id: cb.id });
      }
      return new Response("ok");
    }
    const m = upd.message;
    if (m && m.text && String(m.chat.id) === String(env.CHAT_ID)) {
      const t = m.text.trim().toLowerCase();
      if (t === "/durum" || t === "durum") await durum(env);
      else if (!t.startsWith("/")) await tetikle(env, "soru.yml", { question: m.text.slice(0, 1000) });
    }
    return new Response("ok");
  },

  async scheduled(event, env) {
    if (event.cron === "*/10 * * * *") {
      await webhookOnar(env);
      const z = new Date(event.scheduledTime);
      const h = z.getUTCHours();
      if (z.getUTCMinutes() === 10 && (h === 5 || h === 17 || (h === 16 && z.getUTCDay() === 0))) await bekci(env, event);
      return;
    }
    if (event.cron.startsWith("10 ")) return bekci(env, event);
    const mode = (SAAT_MODU[event.cron] || {})[new Date(event.scheduledTime).getUTCHours()];
    if (!mode) return;
    if (brifAtla(mode, event.scheduledTime)) return;
    await tetikle(env, "brief.yml", { mode });
  },
};
