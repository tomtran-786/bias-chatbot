"use client";

/**
 * Minimal renderer for the assistant's text.
 *
 * The protocol requires the recommendation to arrive under four fixed `##`
 * headings, and models reach for bullets and rules unprompted, so those four
 * constructs are handled. Everything beyond them is left alone deliberately: a
 * full markdown parser would be a dependency and a streaming hazard for a
 * handful of shapes the protocol actually specifies.
 */
/** `*italic*` inside a run that is already known not to be bold. */
function italics(text: string, keyPrefix: string) {
  return text.split(/\*(.+?)\*/g).map((part, index) =>
    index % 2 === 1 ? (
      <em key={`${keyPrefix}-i${index}`} className="italic">
        {part}
      </em>
    ) : (
      part
    ),
  );
}

/**
 * Bold first, then italics inside what is left. Doing it in one pass would let
 * the italic pattern eat the inner asterisks of a bold span.
 */
function inline(text: string, keyPrefix: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, index) =>
    index % 2 === 1 ? (
      <strong key={`${keyPrefix}-${index}`} className="font-medium">
        {part}
      </strong>
    ) : (
      <span key={`${keyPrefix}-${index}`}>{italics(part, `${keyPrefix}-${index}`)}</span>
    ),
  );
}

export function Prose({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 text-[15px] leading-relaxed">
      {text.split("\n").map((line, index) => {
        const trimmed = line.trim();
        if (trimmed === "") return null;

        const heading = trimmed.match(/^#{2,3}\s+(.*)$/);
        if (heading) {
          return (
            <h3
              key={index}
              className="mt-3 text-sm font-semibold tracking-tight text-ink first:mt-0"
            >
              {heading[1]}
            </h3>
          );
        }

        // A horizontal rule, which a model tends to emit before a closing line.
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
          return (
            <hr
              key={index}
              className="my-2 border-rule"
            />
          );
        }

        const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
        if (bullet) {
          return (
            <p key={index} className="flex gap-2 pl-1">
              <span aria-hidden className="text-ink-muted">
                •
              </span>
              <span>{inline(bullet[1], String(index))}</span>
            </p>
          );
        }

        return (
          <p key={index} className="whitespace-pre-wrap">
            {inline(line, String(index))}
          </p>
        );
      })}
    </div>
  );
}
