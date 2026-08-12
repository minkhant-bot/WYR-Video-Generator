import crypto from 'node:crypto';
import { fetchWithTimeout, retry } from './utils.js';

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
const normalizeOption = (option, index, label) => {
  const text = normalize(option?.text); const searchQuery = normalize(option?.searchQuery);
  if (text.length < 3 || text.length > 500) throw new Error(`Question ${index + 1} option ${label} text must contain 3–500 characters before visual fitting.`);
  if (searchQuery.length < 3 || searchQuery.length > 100) throw new Error(`Question ${index + 1} option ${label} search query must contain 3–100 characters.`);
  return { text, searchQuery };
};

const significantWords = text => new Set(text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(word => word.length > 2 && !['the', 'and', 'for', 'you', 'your', 'with', 'every'].includes(word)));
const similarity = (left, right) => {
  const intersection = [...left].filter(word => right.has(word)).length; const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
};

export const validatePlan = (input, questionCount) => {
  if (!input || typeof input !== 'object') throw new Error('Content plan must be an object.');
  const topic = normalize(input.topic);
  if (topic.length < 3 || topic.length > 80) throw new Error('Topic must contain 3–80 characters.');
  if (!Array.isArray(input.questions) || input.questions.length !== questionCount) throw new Error(`Content plan must contain exactly ${questionCount} questions.`);
  const seen = new Set(); const previousWordSets = [];
  const questions = input.questions.map((question, index) => {
    const optionA = normalizeOption(question?.optionA, index, 'A'); const optionB = normalizeOption(question?.optionB, index, 'B');
    if (optionA.text.toLowerCase() === optionB.text.toLowerCase()) throw new Error(`Question ${index + 1} has identical options.`);
    const signature = [optionA.text, optionB.text].map(text => text.toLowerCase()).sort().join('|');
    if (seen.has(signature)) throw new Error(`Question ${index + 1} duplicates another question.`);
    const words = significantWords(signature);
    if (previousWordSets.some(previous => similarity(words, previous) >= 0.65)) throw new Error(`Question ${index + 1} is too similar to another question.`);
    seen.add(signature); previousWordSets.push(words); return { index, optionA, optionB };
  });
  return { version: 1, topic, percentages: null, questions };
};

export class ContentProvider { async generatePlan() { throw new Error('ContentProvider.generatePlan must be implemented.'); } }

export class GroqContentProvider extends ContentProvider {
  constructor({ apiKey, model, timeoutMs }) { super(); this.apiKey = apiKey; this.model = model; this.timeoutMs = timeoutMs; }
  async generatePlan(questionCount) {
    return retry(async () => {
      const optionSchema = { type: 'object', additionalProperties: false, required: ['text', 'searchQuery'], properties: { text: { type: 'string' }, searchQuery: { type: 'string' } } };
      const schema = { type: 'object', additionalProperties: false, required: ['topic', 'questions'], properties: { topic: { type: 'string' }, questions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['optionA', 'optionB'], properties: { optionA: optionSchema, optionB: optionSchema } } } } };
      const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model, temperature: 0.85, max_completion_tokens: 2500,
          messages: [
            { role: 'system', content: 'You create concise, highly visual Would You Rather plans for an English short-form video. Return only data matching the supplied schema.' },
            { role: 'user', content: `Choose one engaging, broadly appealing topic and create exactly ${questionCount} unique questions. Each option must be immediately understandable, 68 characters or fewer, grammatically compatible with “Would you rather”, and easy to narrate naturally. Each searchQuery must be a concrete 2–6 word English Pexels stock-photo query describing visible subjects, setting, and action—not an abstract sentence. Make every question visually distinct. Avoid brands, celebrities, politics, medical claims, sexual content, graphic violence, duplicate choices, and near-duplicates. Do not include percentages.` },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'would_you_rather_plan', strict: true, schema } },
        }),
      }, this.timeoutMs);
      if (!response.ok) throw new Error(`Groq returned HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
      const payload = await response.json(); const message = payload?.choices?.[0]?.message; const text = message?.content;
      if (message?.refusal) throw new Error(`Groq refused content generation: ${String(message.refusal).slice(0, 240)}`);
      if (!text) throw new Error('Groq returned no structured content.');
      const plan = validatePlan(JSON.parse(text), questionCount);
      for (const question of plan.questions) for (const [label, option] of [['A', question.optionA], ['B', question.optionB]]) if (option.text.length > 68) throw new Error(`Groq question ${question.index + 1} option ${label} exceeds the 68-character production limit.`);
      return plan;
    }, { attempts: 2, label: 'content generation' });
  }
}

export const addIllustrativePercentages = plan => ({
  ...plan,
  percentages: { mode: 'illustrative', label: 'Illustrative entertainment split; not audience polling data' },
  questions: plan.questions.map(question => {
    const digest = crypto.createHash('sha256').update(`${question.optionA.text}|${question.optionB.text}`).digest(); const percentage = 38 + digest[0] % 25;
    return { ...question, optionA: { ...question.optionA, percentage }, optionB: { ...question.optionB, percentage: 100 - percentage } };
  }),
});
