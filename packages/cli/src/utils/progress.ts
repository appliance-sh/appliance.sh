import chalk from 'chalk';

// Small terminal helpers. On a TTY we re-print the current status
// line in place via carriage return — same trick `docker build` and
// `npm install` use. On non-TTY (CI, piped output) we degrade to one
// line per *change*, so logs stay readable without flooding.
//
// Intentionally tiny — no spinner frames, no ansi escape soup. Just
// "make a single-line progress feel live without trashing CI logs."

export interface ProgressLine {
  /** Update the current line with new text. */
  update(text: string): void;
  /** Finalize with a one-line summary; subsequent prints stay on
   * a fresh line below. */
  done(text: string): void;
  /** Finalize with a one-line error summary. */
  fail(text: string): void;
  /** Drop the current line without printing anything terminal. */
  clear(): void;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 100;

export function startProgressLine(initial = ''): ProgressLine {
  const stream = process.stdout;
  const tty = Boolean(stream.isTTY);
  let lastText = initial;
  let lastEmitted: string | null = null;

  if (!tty) {
    if (initial) {
      stream.write(`${initial}\n`);
      lastEmitted = initial;
    }
    return {
      update(text) {
        if (text === lastEmitted) return;
        stream.write(`${text}\n`);
        lastEmitted = text;
      },
      done(text) {
        stream.write(`${text}\n`);
      },
      fail(text) {
        stream.write(`${text}\n`);
      },
      clear() {},
    };
  }

  let frame = 0;
  const render = () => {
    const text = `${chalk.cyan(FRAMES[frame % FRAMES.length])} ${lastText}`;
    // Clear the current line, then write the new content. \x1b[2K = EL
    // (Erase in Line: entire line); \r returns to col 0.
    stream.write(`\r\x1b[2K${text}`);
    frame++;
  };

  if (initial) render();
  const interval = setInterval(render, SPINNER_INTERVAL_MS);

  return {
    update(text) {
      lastText = text;
      render();
    },
    done(text) {
      clearInterval(interval);
      stream.write(`\r\x1b[2K${text}\n`);
    },
    fail(text) {
      clearInterval(interval);
      stream.write(`\r\x1b[2K${text}\n`);
    },
    clear() {
      clearInterval(interval);
      stream.write(`\r\x1b[2K`);
    },
  };
}

/** ASCII brand glyph for deploy banners. Matches the Vercel ▲ idiom. */
export const BRAND = '▲';
