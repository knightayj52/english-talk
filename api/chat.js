// ============================================================
// english-talk v3 : Gemini 프록시 (Vercel Serverless Function)
// 경로: /api/chat.js
// v3 변경: 사용자가 자신의 Gemini API 키로 접속하는 모드 추가
//   - userApiKey가 오면 그 키로 호출 (다른 사용자용, 사용량 각자 부담)
//   - 없으면 APP_PASSWORD 검증 후 서버의 GEMINI_API_KEY 사용 (영쌤 전용)
//
// Vercel 환경변수:
//   GEMINI_API_KEY  (필수) 영쌤 키
//   APP_PASSWORD    (필수) 영쌤 접속 암호
//   GEMINI_MODEL    (선택, 기본 gemini-2.5-flash-lite)
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

const AUDIO_INSTRUCTION =
  "(This is the learner's spoken English audio. First, transcribe EXACTLY what the learner said " +
  "into the 'transcript' field, in English. The learner is Korean, so be generous with " +
  "Korean-accented pronunciation and transcribe the words they intended. " +
  "Then respond to what they said, in character. " +
  "If the audio is silent or impossible to understand, set transcript to an empty string " +
  "and in 'reply' gently ask them to try speaking again.)";

function buildSystemPrompt(scenarioId, levelId) {
  const scenario = SCENARIOS[scenarioId] || SCENARIOS.free;
  const level = LEVELS[levelId] || LEVELS.intermediate;
  return [
    'You are "Joy", a warm, patient English conversation partner helping a Korean adult practice spoken English.',
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
    "- Check grammar, word choice, and naturalness of what the learner said (the transcript if audio).",
    '- If there is a real error or unnatural phrasing: set hasIssue=true, give the natural full corrected sentence in "corrected",',
    '  and a SHORT "explanation" written in KOREAN (1-2 sentences, friendly tone).',
    "- If the message is already natural: hasIssue=false, corrected and explanation must be empty strings.",
    "- Do NOT flag punctuation or capitalization issues for spoken audio; judge only the words.",
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
    transcript: {
      type: "STRING",
      description: "For audio input: exact English transcription of what the learner said. For text input: empty string.",
    },
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
  required: ["transcript", "reply", "reply_ko", "feedback"],
};

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
    const userApiKey = String(body.userApiKey || "").trim();
    const scenarioId = body.scenarioId;
    const levelId = body.levelId;
    const history = Array.isArray(body.history) ? body.history : [];
    const userText = String(body.userText || "").trim();
    const audio = body.audio && body.audio.data ? body.audio : null;

    // ── 인증/키 선택 ──
    // 1) 사용자가 자기 키를 보냈으면 그 키를 사용 (사용량 각자 부담)
    // 2) 아니면 접속 암호 확인 후 서버(영쌤) 키 사용
    let apiKey = "";
    if (userApiKey) {
      apiKey = userApiKey;
    } else if (process.env.APP_PASSWORD && password === process.env.APP_PASSWORD) {
      apiKey = process.env.GEMINI_API_KEY || "";
      if (!apiKey) return res.status(200).json({ ok: false, error: "NO_KEY" });
    } else {
      return res.status(200).json({ ok: false, error: "AUTH" });
    }

    if (!userText && !audio) {
      return res.status(200).json({ ok: false, error: "EMPTY" });
    }

    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

    // 대화 이력 (최근 12턴, 텍스트만)
    const contents = [];
    history.slice(-12).forEach(function (m) {
      if (!m || !m.content) return;
      contents.push({
        role: m.role === "ai" ? "model" : "user",
        parts: [{ text: String(m.content) }],
      });
    });

    // 마지막 사용자 턴: 오디오 또는 텍스트
    if (audio) {
      contents.push({
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: String(audio.mimeType || "audio/webm").split(";")[0],
              data: String(audio.data),
            },
          },
          { text: AUDIO_INSTRUCTION },
        ],
      });
    } else {
      const effectiveUserText =
        userText === START_TOKEN
          ? "(The learner just opened the app. Greet them warmly in character, in English, and ask ONE easy opening question to start the scenario. transcript must be an empty string and hasIssue must be false.)"
          : userText;
      contents.push({ role: "user", parts: [{ text: effectiveUserText }] });
    }

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
      if (/API key/i.test(msg)) {
        return res.status(200).json({ ok: false, error: "BAD_KEY" });
      }
      return res.status(200).json({ ok: false, error: "GEMINI", detail: String(msg).slice(0, 200) });
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
      const reason =
        (data.candidates && data.candidates[0] && data.candidates[0].finishReason) || "";
      return res
        .status(200)
        .json({ ok: false, error: "EMPTY_RESPONSE", detail: String(reason).slice(0, 100) });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e1) {
      try {
        parsed = looseParse(rawText);
      } catch (e2) {
        parsed = {
          transcript: "",
          reply: rawText.slice(0, 500),
          reply_ko: "",
          feedback: { hasIssue: false, corrected: "", explanation: "" },
        };
      }
    }

    if (!parsed.feedback) {
      parsed.feedback = { hasIssue: false, corrected: "", explanation: "" };
    }
    if (typeof parsed.transcript !== "string") parsed.transcript = "";

    return res.status(200).json({ ok: true, data: parsed });
  } catch (err) {
    return res
      .status(200)
      .json({ ok: false, error: "SERVER", detail: String((err && err.message) || err).slice(0, 200) });
  }
}
