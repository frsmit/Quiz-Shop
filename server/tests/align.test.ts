import { describe, expect, it } from 'vitest';
import { alignAnswer, alignToOption } from '../src/question/question.service.js';
import type { QuestionAnswer, QuestionRequest } from '../src/question/question.schema.js';
import { buildUserPrompt } from '../src/question/question.prompt.js';

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

describe('alignAnswer', () => {
  const request = (multiSelect: boolean): QuestionRequest => ({
    question: 'Which of these are prepositions of place?',
    type: 'multiple_choice',
    options: OPTIONS,
    multiSelect,
  });

  it('aligns every entry of a multi-select answer to an option', () => {
    const aligned = alignAnswer({ ...answer('x'), answers: ['A. in', 'ON', 'into'] }, request(true));
    expect(aligned.answers).toEqual(['in', 'on', 'into']);
    expect(aligned.answer).toBe('in; on; into');
  });

  it('reads the options from the joined answer when the list is empty', () => {
    const aligned = alignAnswer({ ...answer('in; B. on'), answers: [] }, request(true));
    expect(aligned.answers).toEqual(['in', 'on']);
  });

  it('drops duplicate picks', () => {
    const aligned = alignAnswer({ ...answer('x'), answers: ['on', 'B. on', 'on'] }, request(true));
    expect(aligned.answers).toEqual(['on']);
  });

  it('keeps no list for a single-answer question', () => {
    const aligned = alignAnswer({ ...answer('B. on'), answers: ['B. on'] }, request(false));
    expect(aligned).not.toHaveProperty('answers');
    expect(aligned.answer).toBe('on');
  });
});

describe('buildUserPrompt', () => {
  it('asks for every correct option on a multi-select question', () => {
    const prompt = buildUserPrompt({
      question: 'Which of these are prepositions of place?',
      type: 'multiple_choice',
      options: OPTIONS,
      multiSelect: true,
    });
    expect(prompt).toMatch(/More than one option may be correct/);
    expect(prompt).not.toMatch(/Choose exactly one option/);
  });
});
