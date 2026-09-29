import { describe, expect, it } from 'vitest';
import { alignToOption } from '../src/question/question.service.js';
import type { QuestionAnswer } from '../src/question/question.schema.js';

const OPTIONS = ['in', 'on', 'onto', 'into'];
const answer = (text: string): QuestionAnswer => ({
  answer: text,
  explanation: 'x',
  provider: 'gemini',
  model: 'gemini-3.5-flash',
});

describe('alignToOption', () => {
  it('strips the label a model copied from the prompt', () => {
    expect(alignToOption(answer('B. on'), OPTIONS).answer).toBe('on');
    expect(alignToOption(answer('(d) into'), OPTIONS).answer).toBe('into');
    expect(alignToOption(answer('C) onto'), OPTIONS).answer).toBe('onto');
  });

  it('restores the option exactly as supplied, whatever the case or spacing', () => {
    expect(alignToOption(answer('  ON '), OPTIONS).answer).toBe('on');
  });

  it('prefers the written-out text over a label that disagrees', () => {
    expect(alignToOption(answer('C. on'), OPTIONS).answer).toBe('on');
  });

  it('leaves an answer alone when the text after the label is not an option', () => {
    expect(alignToOption(answer('a. none of these'), OPTIONS).answer).toBe('a. none of these');
  });

  it('leaves answers without options untouched', () => {
    expect(alignToOption(answer('B. on'), undefined).answer).toBe('B. on');
  });
});
