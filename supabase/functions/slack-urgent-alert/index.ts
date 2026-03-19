import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async () => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const slackWebhookUrl = Deno.env.get("SLACK_WEBHOOK_URL")!;

    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: urgentCards, error } = await sb
      .from("cards")
      .select("id, title, brand, due, column")
      .eq("priority", "urgent")
      .neq("column", "done");

    if (error) throw error;
    if (!urgentCards || urgentCards.length === 0) {
      return new Response(JSON.stringify({ message: "긴급 미완료 건 없음" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const colNames: Record<string, string> = {
      backlog: "백로그",
      progress: "진행중",
      today: "오늘집중",
      waiting: "컨펌대기",
    };

    const lines = urgentCards.map((c) => {
      const overdue = c.due && c.due < today ? " :rotating_light: 기한 초과!" : "";
      return `• *${c.title}* (${c.brand || "미지정"}) — 마감: ${c.due || "없음"} / ${colNames[c.column] || c.column}${overdue}`;
    });

    const slackPayload = {
      text: `:warning: *긴급 미완료 업무 알림* (${urgentCards.length}건)\n${today} 기준\n\n${lines.join("\n")}`,
    };

    const slackRes = await fetch(slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slackPayload),
    });

    if (!slackRes.ok) throw new Error(`Slack webhook failed: ${slackRes.status}`);

    return new Response(
      JSON.stringify({ message: `${urgentCards.length}건 Slack 발송 완료` }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
