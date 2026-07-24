// ============================================================
// english-talk : Gemini 프록시 (Vercel Serverless Function)
// 경로: /api/chat.js
//
// Vercel 환경변수 (Settings → Environment Variables):
//   GEMINI_API_KEY  (필수) Google AI Studio에서 발급한 키
//   APP_PASSWORD    (필수) 앱 접속 암호 (영쌤이 원하는 문자열)
//   GEMINI_MODEL    (선택) 기본값 gemini-2.5-flash-lite
// ============================================================

const SCENARIOS = {
  free: "an open, friendly free conversation about anything the learner wants to talk about",
  daily: "casual everyday small talk (weather, weekend plans, food, hobbies, daily life)",
  school: "chatting about school life and teaching, since the learner is a Korean elementary school teacher",
  restaurant: "a restaurant scene where YOU play the server taking the learner's order and chatting naturally",
  travel: "traveling abroad: airport check-in, hotel, asking for directions, shopping (YOU play the local staff)",
  interview: "a warm, encouraging English job interview where YOU play the interviewer",
};

const LEVELS = {
  beginner: "beginner: use short, simple sentences and very common words",
  intermediate: "intermediate: natural everyday English at a comfortable pace",
  advanced: "advanced: natural, idiomatic English with richer vocabulary and follow-up depth",
};

const START_TOKEN = "__START__";

function buildSystemPrompt(scenarioId, levelId) {
  const scenario = SCENARIOS[scenarioId] || SCENARIOS.free;
  const level = LEVELS[levelId] || LEVELS.intermediate;
  return [
    'You are "Joy", a warm, patient English conversation partner helping a Korean adult',
    "(an elementary school teacher) practice spoken English.",
    "",
    "CONTEXT",
    "- Scenario: " + scenario,
    "- Learner level: " + level,
    "",
    'YOUR SPOKEN REPLY ("reply")',
    "- Stay in character for the scenario.",
    "- 1-3 short, natural sentences. ALWAYS end with a question or a prompt so the conversation keeps flowing.",
    "- Match sentence difficulty to the learner's level.",
    "- Vary your expressions; do not repeat the same sentence patterns every turn.",
    "",
    "FEEDBACK on the learner's LATEST message",
    "- Check grammar, word choice, and naturalness.",
    '- If there is a real error or unnatural phrasing: set hasIssue=true, give the natural full corrected sentence in "corrected",',
    '  and a SHORT "explanation" written in KOREAN (1-2 sentences, friendly tone).',
    "- If the message is already natural: hasIssue=false, corrected and explanation must be empty strings.",
    "- Be encouraging. Do not nitpick tiny things at beginner level.",
    "",
    'Also give a natural KOREAN translation of your reply in "reply_ko".',
    "",
    "Return the result as JSON following the provided schema.",
  ].join("\n");
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING", description: "Joy's spoken English reply, 1-3 sentences, ends with a question" },
    reply_ko: { type: "STRING", description: "Natural Korean translation of reply" },
    feedback: {
      type: "OBJECT",
      properties: {
        hasIssue: { type: "BOOLEAN" },
        corrected: { type: "STRING" },
        explanation: { type: "STRING", description: "Short Korean explanation" },
      },
      required: ["hasIssue", "corrected", "explanation"],
    },
  },
  required: ["reply", "reply_ko", "feedback"],
};

// 코드펜스/앞뒤 잡음이 섞여도 JSON만 뽑아내는 보조 파서
function looseParse(text) {
  let t = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "METHOD" });
  }

  try {
    const body = req.body || {};
    const password = body.password;
    const scenarioId = body.scenarioId;
    const levelId = body.levelId;
    const history = Array.isArray(body.history) ? body.history : [];
    const userText = String(body.userText || "").trim();

    // 1) 접속 암호 검증 (무단 사용으로 무료 한도가 새는 것 방지)
    if (!process.env.APP_PASSWORD || password !== process.env.APP_PASSWORD) {
      return res.status(200).json({ ok: false, error: "AUTH" });
    }

    // 2) 키 확인
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(200).json({ ok: false, error: "NO_KEY" });
    }
    if (!userText) {
      return res.status(200).json({ ok: false, error: "EMPTY" });
    }

    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

    // 3) 대화 이력 구성 (최근 12턴만 유지 - 토큰 절약)
    const contents = [];
    history.slice(-12).forEach(function (m) {
      if (!m || !m.content) return;
      contents.push({
        role: m.role === "ai" ? "model" : "user",
        parts: [{ text: String(m.content) }],
      });
    });

    const effectiveUserText =
      userText === START_TOKEN
        ? "(The learner just opened the app. Greet them warmly in character, in English, and ask ONE easy opening question to start the scenario. hasIssue must be false.)"
        : userText;
    contents.push({ role: "user", parts: [{ text: effectiveUserText }] });

    // 4) Gemini 호출
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent?key=" +
      encodeURIComponent(apiKey);

    const gRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt(scenarioId, levelId) }] },
        contents: contents,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          maxOutputTokens: 2048,
          temperature: 0.8,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    const data = await gRes.json().catch(function () {
      return null;
    });

    if (!gRes.ok || !data) {
      const code = data && data.error && data.error.code;
      const msg = (data && data.error && data.error.message) || "Gemini request failed";
      if (code === 429 || /RESOURCE_EXHAUSTED/i.test(msg)) {
        return res.status(200).json({ ok: false, error: "RATE" });
      }
      if (code === 400 && /API key/i.test(msg)) {
        return res.status(200).json({ ok: false, error: "BAD_KEY", detail: msg });
      }
      return res.status(200).json({ ok: false, error: "GEMINI", detail: msg });
    }

    const parts =
      (data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts) ||
      [];
    const rawText = parts
      .map(function (p) {
        return p.text || "";
      })
      .join("");

    if (!rawText) {
      return res.status(200).json({ ok: false, error: "EMPTY_RESPONSE" });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e1) {
      try {
        parsed = looseParse(rawText);
      } catch (e2) {
        // 최후 폴백: 원문을 그대로 대사로 사용
        parsed = {
          reply: rawText.slice(0, 500),
          reply_ko: "",
          feedback: { hasIssue: false, corrected: "", explanation: "" },
        };
      }
    }

    if (!parsed.feedback) {
      parsed.feedback = { hasIssue: false, corrected: "", explanation: "" };
    }

    return res.status(200).json({ ok: true, data: parsed });
  } catch (err) {
    return res
      .status(200)
      .json({ ok: false, error: "SERVER", detail: String((err && err.message) || err) });
  }
}
