import { useId, useRef, type JSX } from 'react';

export const HelpTooltip = ({ label, children, symbol = '?' }: Readonly<{
  label: string;
  children: string;
  symbol?: '?' | '!';
}>): JSX.Element => {
  const id = useId();
  const anchor = `--help-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const tooltip = useRef<HTMLSpanElement>(null);
  const show = (): void => tooltip.current?.showPopover();

  return (
    <span className="help-tooltip" onMouseEnter={show} onFocus={show}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) tooltip.current?.hidePopover();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.matches(':hover')) tooltip.current?.hidePopover();
      }}>
      <button className="help-trigger" type="button" aria-label={`Help: ${label}`}
        aria-describedby={id} style={{ anchorName: anchor }} onClick={show}>{symbol}</button>
      <span className="help-content" id={id} role="tooltip" popover="hint" ref={tooltip}
        style={{ positionAnchor: anchor }}>{children}</span>
    </span>
  );
};
