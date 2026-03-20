import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_API = "https://api.telegram.org/bot";

// ==================== HELPERS ====================

async function sendTelegram(chatId: number, text: string, token: string) {
  // Telegram 4096 char limit
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
  for (const chunk of chunks) {
    await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "Markdown" }),
    });
  }
}

// ==================== CLAUDE PARSING ====================

async function parseMessage(text: string, apiKey: string): Promise<Record<string, unknown>> {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayStr = `${yyyy}-${mm}-${dd}`;

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

  const systemPrompt = `You are a task parser for a Korean advertising agency kanban board.
Today: ${todayStr}. Tomorrow: ${tomorrowStr}.

Parse the user's Korean message into JSON with these fields:

{
  "intent": "add" | "list" | "update" | "delete" | "digest" | "help" | "unknown",
  "title": "task title (for add/update/delete)",
  "brand": "brand name if mentioned",
  "type": "viral|seeding|budget|comm (infer from context)",
  "priority": "urgent|high|normal|low (default: normal)",
  "due": "YYYY-MM-DD (convert relative dates: 내일, 모레, 다음주 등)",
  "column": "backlog|progress|today|waiting|done (default: backlog)",
  "note": "any additional details",
  "filter": { "column": "", "priority": "", "brand": "" },
  "searchTitle": "keyword to find card (for update/delete)",
  "newColumn": "target column (for update)"
}

Intent rules:
- "추가", "만들어", "등록", "해야 해", "해줘" with task → add
- "뭐야", "보여줘", "알려줘", "목록", "리스트" → list
- "완료", "끝", "처리", "옮겨", "변경" → update
- "삭제", "지워", "제거" → delete
- "요약", "브리핑", "현황", "다이제스트" → digest
- "도움", "헬프", "뭐 할 수 있" → help

For "list" intent, set appropriate filter:
- "오늘 할 일" → filter.column = "today"
- "긴급 건" → filter.priority = "urgent"
- "A브랜드" → filter.brand = "A브랜드"
- No specific filter → return all non-done cards

Respond with ONLY valid JSON. No explanation, no markdown.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  const content = data.content?.[0]?.text || "{}";
  return JSON.parse(content);
}

// ==================== DB OPERATIONS ====================

async function addCard(
  sb: ReturnType<typeof createClient>,
  userId: string,
  parsed: Record<string, unknown>
) {
  // Get next ID
  const { data: maxRow } = await sb
    .from("cards")
    .select("id")
    .eq("user_id", userId)
    .order("id", { ascending: false })
    .limit(1);

  const newId = (maxRow && maxRow.length > 0 ? maxRow[0].id : 0) + 1;

  const card = {
    id: newId,
    user_id: userId,
    title: parsed.title || "제목 없음",
    brand: parsed.brand || "",
    type: parsed.type || "viral",
    priority: parsed.priority || "normal",
    due: parsed.due || "",
    note: parsed.note || "",
    url: "",
    column: parsed.column || "backlog",
    attachments: [],
    updated_at: new Date().toISOString(),
  };

  const { error } = await sb.from("cards").insert(card);
  if (error) throw error;

  const colNames: Record<string, string> = {
    backlog: "백로그", progress: "진행중", today: "오늘집중", waiting: "컨펌대기", done: "완료",
  };
  const prioNames: Record<string, string> = {
    urgent: "긴급", high: "높음", normal: "보통", low: "낮음",
  };
  const typeNames: Record<string, string> = {
    viral: "바이럴", seeding: "시딩", budget: "예산", comm: "커뮤니케이션",
  };

  return `✅ *카드 추가 완료!*
제목: ${card.title}
${card.brand ? `광고주: ${card.brand} | ` : ""}유형: ${typeNames[card.type] || card.type}
우선순위: ${prioNames[card.priority] || card.priority}${card.due ? ` | 마감: ${card.due}` : ""}
상태: ${colNames[card.column] || card.column}`;
}

async function listCards(
  sb: ReturnType<typeof createClient>,
  userId: string,
  filter: Record<string, string>
) {
  let query = sb
    .from("cards")
    .select("id, title, brand, priority, due, column, type")
    .eq("user_id", userId);

  if (filter?.column) query = query.eq("column", filter.column);
  if (filter?.priority) query = query.eq("priority", filter.priority);
  if (filter?.brand) query = query.ilike("brand", `%${filter.brand}%`);
  if (!filter?.column) query = query.neq("column", "done");

  query = query.order("id", { ascending: true }).limit(15);

  const { data: cards, error } = await query;
  if (error) throw error;
  if (!cards || cards.length === 0) return "📋 해당하는 카드가 없습니다.";

  const colNames: Record<string, string> = {
    backlog: "백로그", progress: "진행중", today: "오늘집중", waiting: "컨펌대기", done: "완료",
  };
  const prioEmoji: Record<string, string> = {
    urgent: "🔴", high: "🟠", normal: "🔵", low: "⚪",
  };

  const title = filter?.column
    ? `${colNames[filter.column] || filter.column}`
    : filter?.priority
    ? `우선순위: ${filter.priority}`
    : filter?.brand
    ? `${filter.brand}`
    : "전체 미완료";

  const lines = cards.map(
    (c, i) =>
      `${i + 1}. ${prioEmoji[c.priority] || "⚪"} *${c.title}*${c.brand ? ` (${c.brand})` : ""}${c.due ? ` — 마감: ${c.due}` : ""} [${colNames[c.column] || c.column}]`
  );

  return `📋 *${title}* (${cards.length}건)\n\n${lines.join("\n")}`;
}

async function updateCard(
  sb: ReturnType<typeof createClient>,
  userId: string,
  parsed: Record<string, unknown>
) {
  const keyword = (parsed.searchTitle as string) || (parsed.title as string) || "";
  if (!keyword) return "❓ 어떤 카드를 변경할지 알려주세요.";

  const { data: cards, error } = await sb
    .from("cards")
    .select("id, title, column")
    .eq("user_id", userId)
    .ilike("title", `%${keyword}%`);

  if (error) throw error;
  if (!cards || cards.length === 0) return `❌ "${keyword}" 관련 카드를 찾을 수 없어요.`;

  if (cards.length > 1) {
    const list = cards.map((c, i) => `${i + 1}. ${c.title}`).join("\n");
    return `🔍 여러 카드가 검색됐어요. 더 구체적으로 말해주세요:\n\n${list}`;
  }

  const card = cards[0];
  const newCol = (parsed.newColumn as string) || "done";
  const colNames: Record<string, string> = {
    backlog: "백로그", progress: "진행중", today: "오늘집중", waiting: "컨펌대기", done: "완료",
  };

  const { error: updateErr } = await sb
    .from("cards")
    .update({ column: newCol, updated_at: new Date().toISOString() })
    .eq("id", card.id)
    .eq("user_id", userId);

  if (updateErr) throw updateErr;

  return `✏️ *업데이트 완료!*\n"${card.title}" → ${colNames[newCol] || newCol}`;
}

async function deleteCard(
  sb: ReturnType<typeof createClient>,
  userId: string,
  parsed: Record<string, unknown>
) {
  const keyword = (parsed.searchTitle as string) || (parsed.title as string) || "";
  if (!keyword) return "❓ 어떤 카드를 삭제할지 알려주세요.";

  const { data: cards, error } = await sb
    .from("cards")
    .select("id, title")
    .eq("user_id", userId)
    .ilike("title", `%${keyword}%`);

  if (error) throw error;
  if (!cards || cards.length === 0) return `❌ "${keyword}" 관련 카드를 찾을 수 없어요.`;

  if (cards.length > 1) {
    const list = cards.map((c, i) => `${i + 1}. ${c.title}`).join("\n");
    return `🔍 여러 카드가 검색됐어요. 더 구체적으로 말해주세요:\n\n${list}`;
  }

  const card = cards[0];
  const { error: delErr } = await sb
    .from("cards")
    .delete()
    .eq("id", card.id)
    .eq("user_id", userId);

  if (delErr) throw delErr;
  return `🗑️ *삭제 완료!*\n"${card.title}"`;
}

async function getDigest(
  sb: ReturnType<typeof createClient>,
  userId: string
) {
  const { data: cards, error } = await sb
    .from("cards")
    .select("title, brand, priority, due, column")
    .eq("user_id", userId)
    .neq("column", "done");

  if (error) throw error;
  if (!cards || cards.length === 0) return "🎉 미완료 업무가 없어요!";

  const today = new Date().toISOString().slice(0, 10);
  const urgent = cards.filter((c) => c.priority === "urgent");
  const todayCol = cards.filter((c) => c.column === "today");
  const overdue = cards.filter((c) => c.due && c.due < today);

  let msg = `📊 *오늘의 업무 현황* (${today})\n\n`;
  msg += `전체 미완료: *${cards.length}건*\n`;

  if (urgent.length > 0) {
    msg += `\n🔴 *긴급* (${urgent.length}건)\n`;
    urgent.forEach((c) => { msg += `  • ${c.title}${c.brand ? ` (${c.brand})` : ""}${c.due ? ` — ${c.due}` : ""}\n`; });
  }
  if (todayCol.length > 0) {
    msg += `\n⚡ *오늘 집중* (${todayCol.length}건)\n`;
    todayCol.forEach((c) => { msg += `  • ${c.title}${c.brand ? ` (${c.brand})` : ""}\n`; });
  }
  if (overdue.length > 0) {
    msg += `\n⏰ *기한 초과* (${overdue.length}건)\n`;
    overdue.forEach((c) => { msg += `  • ${c.title} — 마감: ${c.due}\n`; });
  }

  return msg;
}

// ==================== HELP ====================

function getHelp(): string {
  return `🤖 *젤리 사용법*

💬 *자연어로 말하면 돼요:*

📌 *카드 추가*
  "내일까지 A브랜드 바이럴 기획안 작성해줘"
  "긴급 B브랜드 시딩 인플루언서 선정"

📋 *카드 조회*
  "오늘 할 일 뭐야?"
  "긴급 건 보여줘"
  "A브랜드 업무 목록"

✏️ *상태 변경*
  "A브랜드 바이럴 완료 처리해줘"
  "기획안 작성 진행중으로 옮겨"

🗑️ *삭제*
  "테스트 카드 삭제해줘"

📊 *현황 요약*
  "오늘 요약" / "현황 브리핑"`;
}

// ==================== MAIN HANDLER ====================

serve(async (req: Request) => {
  try {
    // Verify webhook secret
    const url = new URL(req.url);
    const secret = url.searchParams.get("secret");
    const webhookSecret = Deno.env.get("WEBHOOK_SECRET");
    if (webhookSecret && secret !== webhookSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = await req.json();
    const message = body.message;
    if (!message?.text) {
      return new Response("OK", { status: 200 });
    }

    const chatId = message.chat.id;
    const text = message.text.trim();
    const token = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY")!;
    const userId = Deno.env.get("ADMIN_USER_ID")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const sb = createClient(supabaseUrl, serviceRoleKey);

    // Handle /start and /help commands directly
    if (text === "/start" || text === "/help") {
      await sendTelegram(chatId, getHelp(), token);
      return new Response("OK", { status: 200 });
    }

    // Parse with Claude
    const parsed = await parseMessage(text, apiKey);
    const intent = parsed.intent as string;

    let reply: string;

    switch (intent) {
      case "add":
        reply = await addCard(sb, userId, parsed);
        break;
      case "list":
        reply = await listCards(sb, userId, (parsed.filter as Record<string, string>) || {});
        break;
      case "update":
        reply = await updateCard(sb, userId, parsed);
        break;
      case "delete":
        reply = await deleteCard(sb, userId, parsed);
        break;
      case "digest":
        reply = await getDigest(sb, userId);
        break;
      case "help":
        reply = getHelp();
        break;
      default:
        reply = "🤔 잘 이해하지 못했어요. 다시 말해주시겠어요?\n\n도움말: /help";
    }

    await sendTelegram(chatId, reply, token);
    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error("Error:", e);
    // Try to send error message to user
    try {
      const body = await req.clone().json();
      const chatId = body.message?.chat?.id;
      const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
      if (chatId && token) {
        await sendTelegram(chatId, "⚠️ 처리 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.", token);
      }
    } catch (_) { /* ignore */ }
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
