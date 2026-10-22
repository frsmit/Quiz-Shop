/**
 * Demo quiz behaviour.
 *
 * Two things matter for exercising the extension:
 *   1. questions can arrive after first paint (MutationObserver path), and
 *   2. existing questions can be destroyed and rebuilt (deduplication path).
 */

const LATE_QUESTIONS = [
  {
    id: 'q-git',
    heading: 'Question 11',
    prompt: 'Which Git command creates a new branch and switches to it in one step?',
    options: ['git branch new-feature', 'git checkout -b new-feature', 'git merge new-feature', 'git switch --merge'],
  },
  {
    id: 'q-python',
    heading: 'Question 12',
    prompt: 'In Python, what does the len() built-in return for the string "quiz"?',
    options: ['3', '4', '5', 'It raises a TypeError'],
  },
];

const dynamicRoot = document.getElementById('dynamic-questions');
const status = document.getElementById('controls-status');

/** Build a question section using yet another DOM shape: divs with roles. */
function buildQuestion(question, index) {
  const section = document.createElement('section');
  section.className = 'question';
  section.id = question.id;

  const heading = document.createElement('h2');
  heading.textContent = question.heading;
  section.append(heading);

  const group = document.createElement('div');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-labelledby', `${question.id}-prompt`);

  const prompt = document.createElement('p');
  prompt.className = 'prompt';
  prompt.id = `${question.id}-prompt`;
  prompt.textContent = question.prompt;
  group.append(prompt);

  question.options.forEach((option, optionIndex) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'option';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = `dynamic-${index}`;
    input.id = `${question.id}-${optionIndex}`;
    input.value = String(optionIndex);

    const label = document.createElement('label');
    label.setAttribute('for', input.id);
    label.textContent = option;

    wrapper.append(input, label);
    group.append(wrapper);
  });

  section.append(group);
  return section;
}

function announce(message) {
  if (status) status.textContent = message;
}

document.getElementById('load-more')?.addEventListener('click', (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  announce('Loading…');

  // A deliberate delay so the questions arrive well after the initial scan.
  setTimeout(() => {
    LATE_QUESTIONS.forEach((question, index) => {
      dynamicRoot?.append(buildQuestion(question, index));
    });
    announce('Two questions added.');
  }, 900);
});

document.getElementById('rerender')?.addEventListener('click', () => {
  const sections = Array.from(document.querySelectorAll('.question'));
  for (const section of sections) {
    const replacement = section.cloneNode(true);
    section.replaceWith(replacement);
  }
  announce(`Rebuilt ${sections.length} question nodes.`);
});

/*
 * Question 9 behaves like a component-library radio group: the hidden input's
 * own click is cancelled, and the row selects itself on mousedown. A script
 * that only calls input.click() leaves it unanswered.
 */
for (const list of document.querySelectorAll('[data-choice-list]')) {
  list.addEventListener('click', (event) => {
    if (event.target instanceof HTMLInputElement) event.preventDefault();
  });
  list.addEventListener('mousedown', (event) => {
    const row = event.target instanceof Element ? event.target.closest('.choice-row') : null;
    if (!row) return;
    for (const other of list.querySelectorAll('.choice-row')) {
      other.classList.toggle('is-selected', other === row);
      other.querySelector('input').checked = other === row;
    }
  });
}

/* Question 10: ARIA radios that keep their state in aria-checked. */
for (const group of document.querySelectorAll('[data-aria-group]')) {
  const select = (option) => {
    for (const other of group.querySelectorAll('[role="radio"]')) {
      other.setAttribute('aria-checked', String(other === option));
      other.tabIndex = other === option ? 0 : -1;
    }
  };
  group.addEventListener('click', (event) => {
    const option = event.target instanceof Element ? event.target.closest('[role="radio"]') : null;
    if (option) select(option);
  });
  group.addEventListener('keydown', (event) => {
    const option = event.target instanceof Element ? event.target.closest('[role="radio"]') : null;
    if (option && event.key === ' ') {
      event.preventDefault();
      select(option);
    }
  });
}
