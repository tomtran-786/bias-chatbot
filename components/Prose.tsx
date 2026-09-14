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
function inline(text: string, keyPrefix: string) {
  // Split on **bold** spans, keeping the delimited contents.
  return text.split(/\*\*(.+?)\*\*/g).map((part, index) =>
    index % 2 === 1 ? (
      <strong key={`${keyPrefix}-${index}`} className="font-medium">
        {part}
      </strong>
    ) : (
      part
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
              className="mt-3 text-sm font-semibold tracking-tight text-neutral-900 first:mt-0 dark:text-neutral-100"
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
              className="my-2 border-neutral-200 dark:border-neutral-800"
            />
          );
        }

        const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
        if (bullet) {
          return (
            <p key={index} className="flex gap-2 pl-1">
              <span aria-hidden className="text-neutral-400">
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
