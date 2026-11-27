import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { Select as Root, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";
import { cn } from "../lib/utils";

interface OptionProps { value?: string | number; disabled?: boolean; children?: ReactNode }
interface Props {
  value?: string | number | null;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  id?: string; name?: string; disabled?: boolean; required?: boolean;
  className?: string; title?: string;
  "aria-label"?: string; "aria-describedby"?: string;
}
const empty = "__gungun_empty_option__";
function options(children: ReactNode, output: {value: string; label: ReactNode; disabled: boolean}[] = []) {
  Children.forEach(children, (child) => {
    if (!isValidElement<OptionProps>(child)) return;
    if (child.type === Fragment || child.type === "optgroup") { options(child.props.children, output); return; }
    if (child.type !== "option") return;
    const value = String(child.props.value ?? "");
    output.push({ value: value || empty, label: child.props.children, disabled: !!child.props.disabled });
  });
  return output;
}
export function SelectField({ value, onValueChange, children, id, name, disabled, required, className, title, ...accessibility }: Props) {
  const items = options(children);
  return <Root
    items={items}
    value={String(value ?? "") || empty}
    onValueChange={(next) => onValueChange?.(next === empty || next === null ? "" : String(next))}
    name={name} disabled={disabled} required={required}
  >
    <SelectTrigger id={id} className={cn("w-full min-w-0", className)} title={title} {...accessibility}>
      <SelectValue placeholder="请选择" className="min-w-0 truncate" />
    </SelectTrigger>
    <SelectContent align="start" alignItemWithTrigger={false}>
      {items.map((item) => <SelectItem key={item.value} value={item.value} disabled={item.disabled}>{item.label}</SelectItem>)}
    </SelectContent>
  </Root>;
}

