import { describe, it, expect } from 'vitest';
import {
  parseVerdict,
  resolveClarifierAction,
  buildClarifierMessages,
  ClarifierParseError,
  MAX_CLARIFICATION_ROUNDS,
  type ClarifierVerdict,
  type ClarifierQuestion,
} from './clarifierCore';

// ---------------------------------------------------------------------------
// parseVerdict
// ---------------------------------------------------------------------------

describe('parseVerdict', () => {
  it('parses a bare ready:true object', () => {
    expect(parseVerdict('{"ready": true}')).toEqual({ ready: true });
  });

  it('parses ready:false with a single question', () => {
    const text = '{"ready": false, "questions": [{"prompt": "Which browser?"}]}';
    const result = parseVerdict(text);
    expect(result).toEqual({ ready: false, questions: [{ prompt: 'Which browser?' }] });
  });

  it('extracts JSON embedded in prose and preserves options + multiselect', () => {
    const text =
      'Sure!\n{"ready": false, "questions": [{"prompt":"P","options":["a","b"],"multiselect":true}]}\nDone';
    const result = parseVerdict(text);
    expect(result).toEqual({
      ready: false,
      questions: [{ prompt: 'P', options: ['a', 'b'], multiselect: true }],
    });
  });

  it('throws ClarifierParseError when there is no JSON', () => {
    expect(() => parseVerdict('no json here')).toThrow(ClarifierParseError);
  });

  it('throws ClarifierParseError when `ready` key is missing', () => {
    expect(() => parseVerdict('{"questions": []}')).toThrow(ClarifierParseError);
  });

  it('throws ClarifierParseError when ready:false has no questions key', () => {
    expect(() => parseVerdict('{"ready": false}')).toThrow(ClarifierParseError);
  });

  it('throws ClarifierParseError when ready:false has an empty questions array', () => {
    expect(() => parseVerdict('{"ready": false, "questions": []}')).toThrow(ClarifierParseError);
  });

  it('throws ClarifierParseError when ready:false has a non-array questions value', () => {
    expect(() => parseVerdict('{"ready": false, "questions": "ask something"}')).toThrow(ClarifierParseError);
  });

  it('throws ClarifierParseError when a question has a non-string prompt', () => {
    expect(() =>
      parseVerdict('{"ready": false, "questions": [{"prompt": 42}]}'),
    ).toThrow(ClarifierParseError);
  });

  it('throws ClarifierParseError when a question has an empty-string prompt', () => {
    expect(() =>
      parseVerdict('{"ready": false, "questions": [{"prompt": ""}]}'),
    ).toThrow(ClarifierParseError);
  });

  it('throws ClarifierParseError when options contains non-string elements (numbers)', () => {
    expect(() =>
      parseVerdict('{"ready": false, "questions": [{"prompt":"P","options":[1,2]}]}'),
    ).toThrow(ClarifierParseError);
  });

  it('throws ClarifierParseError when options contains non-string elements (null)', () => {
    expect(() =>
      parseVerdict('{"ready": false, "questions": [{"prompt":"P","options":["a",null]}]}'),
    ).toThrow(ClarifierParseError);
  });

  it('throws ClarifierParseError when multiselect:true is set without options', () => {
    expect(() =>
      parseVerdict('{"ready": false, "questions": [{"prompt":"P","multiselect":true}]}'),
    ).toThrow(ClarifierParseError);
  });

  it('parses successfully when multiselect:true is paired with options', () => {
    const result = parseVerdict(
      '{"ready": false, "questions": [{"prompt":"P","options":["a","b"],"multiselect":true}]}',
    );
    expect(result).toEqual({
      ready: false,
      questions: [{ prompt: 'P', options: ['a', 'b'], multiselect: true }],
    });
  });
});

// ---------------------------------------------------------------------------
// resolveClarifierAction
// ---------------------------------------------------------------------------

describe('resolveClarifierAction', () => {
  const questions: ClarifierQuestion[] = [{ prompt: 'What is the target platform?' }];
  const readyVerdict: ClarifierVerdict = { ready: true };
  const pendingVerdict: ClarifierVerdict = { ready: false, questions };

  it('proceeds with reason:ready when verdict is ready at round 0', () => {
    expect(resolveClarifierAction(0, readyVerdict)).toEqual({ action: 'proceed', reason: 'ready' });
  });

  it('asks when verdict is needs-input at round 0', () => {
    expect(resolveClarifierAction(0, pendingVerdict)).toEqual({ action: 'ask', questions });
  });

  it('forces proceed with reason:max_rounds when round === MAX_CLARIFICATION_ROUNDS', () => {
    expect(resolveClarifierAction(MAX_CLARIFICATION_ROUNDS, pendingVerdict)).toEqual({
      action: 'proceed',
      reason: 'max_rounds',
    });
  });

  it('still asks when round is one below MAX_CLARIFICATION_ROUNDS', () => {
    expect(resolveClarifierAction(MAX_CLARIFICATION_ROUNDS - 1, pendingVerdict)).toEqual({
      action: 'ask',
      questions,
    });
  });

  it('proceeds with reason:ready even at round MAX when verdict is ready', () => {
    expect(resolveClarifierAction(MAX_CLARIFICATION_ROUNDS, readyVerdict)).toEqual({
      action: 'proceed',
      reason: 'ready',
    });
  });
});

// ---------------------------------------------------------------------------
// buildClarifierMessages
// ---------------------------------------------------------------------------

describe('buildClarifierMessages', () => {
  const ticket = { title: 'Add dark mode', description: 'The app should support dark mode' };

  it('returns an object with system string and messages array', () => {
    const result = buildClarifierMessages(ticket, []);
    expect(typeof result.system).toBe('string');
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('system prompt mentions requirements-level questions only', () => {
    const { system } = buildClarifierMessages(ticket, []);
    expect(system.toLowerCase()).toMatch(/requirement/);
    // Must NOT encourage code-level questions
    const lowerSystem = system.toLowerCase();
    expect(lowerSystem).toMatch(/requirements.level|requirements level/);
  });

  it('system prompt instructs to output strict JSON of the verdict shape', () => {
    const { system } = buildClarifierMessages(ticket, []);
    // Must mention JSON and the exact keys
    expect(system).toMatch(/JSON/);
    expect(system).toMatch(/"ready"/);
    expect(system).toMatch(/"questions"/);
  });

  it('system prompt instructs output ONLY the JSON object (no prose)', () => {
    const { system } = buildClarifierMessages(ticket, []);
    const lower = system.toLowerCase();
    // Should instruct to output only the JSON, not surrounding prose
    expect(lower).toMatch(/only\s+(a\s+)?json|output only/);
  });

  it('user message contains the ticket title', () => {
    const { messages } = buildClarifierMessages(ticket, []);
    const content = messages.map(m => m.content).join('\n');
    expect(content).toContain('Add dark mode');
  });

  it('user message contains the ticket description', () => {
    const { messages } = buildClarifierMessages(ticket, []);
    const content = messages.map(m => m.content).join('\n');
    expect(content).toContain('The app should support dark mode');
  });

  it('works with null description', () => {
    const result = buildClarifierMessages({ title: 'Fix crash', description: null }, []);
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('includes prior Q&A pairs in the user message', () => {
    const qa = [
      { question: 'Which browsers?', answer: 'Chrome and Firefox' },
      { question: 'Mobile too?', answer: 'Yes' },
    ];
    const { messages } = buildClarifierMessages(ticket, qa);
    const content = messages.map(m => m.content).join('\n');
    expect(content).toContain('Which browsers?');
    expect(content).toContain('Chrome and Firefox');
    expect(content).toContain('Mobile too?');
    expect(content).toContain('Yes');
  });

  it('all messages have role:user', () => {
    const { messages } = buildClarifierMessages(ticket, [
      { question: 'Why?', answer: 'Because' },
    ]);
    for (const m of messages) {
      expect(m.role).toBe('user');
    }
  });
});
