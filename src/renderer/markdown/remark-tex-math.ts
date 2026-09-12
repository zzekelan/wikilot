import type {} from "remark-parse";
import type { Code, State, Tokenizer } from "micromark-util-types";
import type { Processor } from "unified";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    texMath: "texMath";
    texMathData: "texMathData";
  }
}

// Recognize TeX delimiters before CommonMark consumes their backslashes as
// escapes. A syntax extension leaves code, URLs, and dollar math untouched.
const tokenize: Tokenizer = function (effects, ok, nok) {
  let closing: number;
  return start;

  function start(code: Code) {
    effects.enter("texMath");
    effects.enter("texMathData");
    effects.consume(code);
    return open;
  }

  function open(code: Code) {
    if (code !== 40 && code !== 91) return nok(code);
    closing = code === 40 ? 41 : 93;
    effects.consume(code);
    effects.exit("texMathData");
    return inside;
  }

  function inside(code: Code): State | undefined {
    if (code === null) return nok(code);
    if (code === -5 || code === -4 || code === -3) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return inside;
    }
    effects.enter("texMathData");
    return content(code);
  }

  function content(code: Code): State | undefined {
    if (code === null || code === -5 || code === -4 || code === -3) {
      effects.exit("texMathData");
      return inside(code);
    }
    effects.consume(code);
    return code === 92 ? escaped : content;
  }

  function escaped(code: Code): State | undefined {
    if (code === closing) {
      effects.consume(code);
      effects.exit("texMathData");
      effects.exit("texMath");
      return ok;
    }
    if (code === null || code === -5 || code === -4 || code === -3) {
      effects.exit("texMathData");
      return inside(code);
    }
    // Consume escaped backslashes together so \\] does not end the formula.
    effects.consume(code);
    return content;
  }
};

export function remarkTexMath(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({
    text: { 92: { name: "texMath", tokenize } },
  });
  (data.fromMarkdownExtensions ??= []).push({
    enter: {
      texMath(token) {
        const source = this.sliceSerialize(token);
        const value = source.slice(2, -2).trim();
        this.enter({
          type: "inlineMath",
          value,
          data: {
            hName: "code",
            hProperties: { className: ["language-math", source[1] === "[" ? "math-display" : "math-inline"] },
            hChildren: [{ type: "text", value }],
          },
        }, token);
        this.buffer();
      },
    },
    exit: { texMath(token) { this.resume(); this.exit(token); } },
  });
}
