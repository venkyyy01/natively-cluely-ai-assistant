import test from 'node:test';
import assert from 'node:assert/strict';
import { clampResponse } from '../llm/postProcessor';

// NAT-047 / audit A-13.
//
// Pre-fix behavior: clampResponse → stripMarkdown ran
//   result.replace(/\n+/g, ' ');
//   result.replace(/\s+/g, ' ');
// which collapsed *every* newline (including blank-line paragraph
// breaks) into a single space. Multi-paragraph prose answers were
// rendered to the user as a wall of text, which both hurts readability
// and makes the answer feel lower-quality even when the model produced
// it correctly.
//
// Post-fix contract:
//   * Blank-line paragraph breaks survive (collapsed to exactly one
//     blank line).
//   * Single newlines from wrap are collapsed to a space (so we don't
//     introduce false breaks every 80 columns).
//   * Trailing whitespace on a line never creates a phantom break.
//   * In-line whitespace (spaces/tabs) is still normalized.
//   * Code fences are still preserved verbatim (existing contract).

test('NAT-047: prose with paragraph breaks retains a single blank line between paragraphs', () => {
    const input =
        'First paragraph that explains the high-level idea.\n\n' +
        'Second paragraph that gives the concrete steps.\n\n' +
        'Third paragraph that names the trade-off.';

    // Use generous caps so clampResponse does not truncate.
    const out = clampResponse(input, 99, 999);

    // Each paragraph appears in order.
    assert.match(out, /First paragraph/);
    assert.match(out, /Second paragraph/);
    assert.match(out, /Third paragraph/);

    // And they are separated by exactly one blank line, not flattened
    // to a space, and not blown up to multiple blank lines.
    assert.match(out, /idea\.\n\nSecond paragraph/);
    assert.match(out, /steps\.\n\nThird paragraph/);
    assert.doesNotMatch(out, /\n{3,}/);
});

test('NAT-047: single line wraps inside a paragraph collapse to a space', () => {
    // Many providers stream prose with embedded \n line wraps inside a
    // single logical paragraph. We must NOT keep those as breaks.
    const input =
        'this is one continuous thought\nthat happens to be wrapped\nacross three physical lines.';

    const out = clampResponse(input, 99, 999);
    assert.equal(
        out,
        'this is one continuous thought that happens to be wrapped across three physical lines.',
    );
});

test('NAT-047: trailing whitespace before a newline does not create a phantom break', () => {
    // "foo   \nbar" is a wrap, not a paragraph break. The pre-fix code
    // got this right by accident (collapsed everything anyway). The
    // new code must still get it right on purpose.
    const input = 'foo   \nbar';
    const out = clampResponse(input, 99, 999);
    assert.equal(out, 'foo bar');
});

test('NAT-047: 3+ blank lines collapse to exactly one blank line', () => {
    const input = 'first\n\n\n\n\nsecond';
    const out = clampResponse(input, 99, 999);
    assert.equal(out, 'first\n\nsecond');
});

test('NAT-047: code fences are preserved verbatim and not subject to paragraph-break logic', () => {
    const input =
        'Here is the solution:\n\n' +
        '```ts\nconst x = 1;\nconst y = 2;\n```\n\n' +
        'And that is why it works.';

    const out = clampResponse(input, 99, 999);
    // Code-fence body is preserved including its internal newlines.
    assert.match(out, /```ts\nconst x = 1;\nconst y = 2;\n```/);
    // Surrounding prose still readable.
    assert.match(out, /Here is the solution:/);
    assert.match(out, /And that is why it works\./);
});

test('NAT-047: in-line repeated spaces/tabs are still collapsed', () => {
    const input = 'multiple    spaces\tand\ttabs   here';
    const out = clampResponse(input, 99, 999);
    assert.equal(out, 'multiple spaces and tabs here');
});
