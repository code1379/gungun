import {
  useState,
  useId,
  isValidElement,
  cloneElement,
  type ReactNode,
  type ComponentProps,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Checkbox } from "./ui/checkbox";
import { SelectField as Select } from "./select-field";
import { Badge as BadgePrimitive } from "./ui/badge";
import { cn } from "../lib/utils";
import { X, AlertTriangle, Check, Server, CircleHelp, ExternalLink, LoaderCircle } from "lucide-react";
import { errorText, useApp } from "../api";
import { Button as StyledButton } from "./ui/button";
export { Input, Textarea, Checkbox, Select };
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from "./ui/table";
export { Progress } from "./ui/progress";
export function Button({
  variant = "secondary",
  className,
  size,
  loading = false,
  disabled,
  children,
  ...props
}: Omit<ComponentProps<typeof StyledButton>, "variant"> & {
  variant?: ComponentProps<typeof StyledButton>["variant"] | "danger";
  loading?: boolean;
}) {
  return (
    <StyledButton
      {...props}
      disabled={disabled || loading}
      aria-busy={loading}
      variant={variant === "danger" ? "destructive" : variant}
      className={className}
      size={
        size ||
        (typeof className === "string" && className.includes("icon-only")
          ? "icon"
          : "default")
      }
    >
      {loading && <LoaderCircle size={14} className="mr-1 shrink-0 animate-spin" />}
      {children}
    </StyledButton>
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className={cn(
          "max-h-[85vh] overflow-y-auto sm:max-w-[540px]",
          wide && "sm:max-w-[820px]",
        )}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description || ""}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function Field({
  label,
  hint,
  help,
  children,
}: {
  label: string;
  hint?: string;
  help?: {
    title: string;
    description: string;
    steps?: string[];
    url?: string;
    linkLabel?: string;
  };
  children: ReactNode;
}) {
  const id = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  const { call, run } = useApp();
  const direct =
    isValidElement<{ id?: string; "aria-describedby"?: string }>(children) &&
    ((typeof children.type === "string" &&
      ["input", "select", "textarea"].includes(children.type)) ||
      [Input, Textarea, Select, Checkbox].includes(
        children.type as typeof Input,
      ));
  return (
    <div className="field mb-4 grid min-w-0 gap-2">
      <div className="flex items-center gap-1.5">
        {direct ? <Label htmlFor={id}>{label}</Label> : <span className="text-xs font-medium">{label}</span>}
        {help && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5 rounded-full p-0 text-muted-foreground hover:text-foreground"
            aria-label={`${label} 帮助`}
            onClick={() => setHelpOpen(true)}
          >
            <CircleHelp size={15} />
          </Button>
        )}
      </div>
      {direct
        ? cloneElement(children, {
            id,
            "aria-describedby": hint ? `${id}-hint` : undefined,
          })
        : children}
      {hint && (
        <small id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </small>
      )}
      {help && (
        <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title={help.title} description={help.description}>
          {help.steps?.length ? (
            <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed">
              {help.steps.map((step, index) => <li key={index}>{step}</li>)}
            </ol>
          ) : null}
          {help.url && (
            <div className="form-actions">
              <Button type="button" variant="default" onClick={() => {
                void run(() => call("openExternal", help.url), "已在默认浏览器中打开官方页面");
              }}>
                <ExternalLink size={14} />
                {help.linkLabel || "打开官方页面"}
              </Button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border px-8 py-14 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Server size={23} />
      </div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="max-w-[48ch] text-sm leading-relaxed text-muted-foreground">
        {children}
      </p>
      {action}
    </div>
  );
}
export function PageHeader({
  title,
  description,
  leading,
  actions,
}: {
  title: string;
  description: string;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {leading && <div className="shrink-0 pt-0.5">{leading}</div>}
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          <p className="mt-2 max-w-[72ch] text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "bad" | "blue";
}) {
  return (
    <BadgePrimitive
      variant="secondary"
      className={cn(
        "font-medium",
        tone === "good" &&
          "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "bad" && "bg-destructive/10 text-destructive",
        tone === "blue" && "bg-primary/15 text-primary",
      )}
    >
      {children}
    </BadgePrimitive>
  );
}
export function Confirm({
  children,
  onConfirm,
  title,
  description,
}: {
  children: ReactNode;
  onConfirm: () => Promise<unknown>;
  title: string;
  description: string;
}) {
  const [open, setOpen] = useState(false);
  const { run } = useApp();
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        description={description}
      >
        <div className="form-actions">
          <Button onClick={() => setOpen(false)}>取消</Button>
          <Button
            variant="danger"
            onClick={() => {
              void run(async () => {
                await onConfirm();
                setOpen(false);
              }, "已删除");
            }}
          >
            确认删除
          </Button>
        </div>
      </Modal>
    </>
  );
}
export function ErrorView({ error }: { error: string }) {
  const { call, run } = useApp();
  let host: { address: string; fingerprint: string; code: string } | null =
    null;
  try {
    const start = error.indexOf("{");
    host = JSON.parse(error.slice(start, error.lastIndexOf("}") + 1));
    if (!host?.code?.startsWith("HOST_KEY")) host = null;
  } catch {
    /* 普通错误 */
  }
  const h = host;
  return (
    <div className="error-view">
      <AlertTriangle size={17} />
      <div>
        <p>{errorText(error)}</p>
        {h && (
          <>
            <p className="mono">
              {h.address}
              <br />
              {h.fingerprint}
            </p>
            <p>请通过服务商控制台或可信渠道核验 SHA256 指纹。</p>
            <Button
              variant="danger"
              onClick={() => {
                void run(
                  () =>
                    call("trustHost", {
                      address: h.address,
                      fingerprint: h.fingerprint,
                    }),
                  "已更新主机信任，请重新连接",
                );
              }}
            >
              已独立核验，信任此指纹
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
export function Feedback() {
  const { message, error, clear } = useApp();
  if (!message && !error) return null;
  return (
    <div
      className={`feedback ${error ? "feedback-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {error ? (
        <ErrorView error={error} />
      ) : (
        <span>
          <Check size={16} />
          {message}
        </span>
      )}
      <Button variant="ghost" onClick={clear} aria-label="关闭提示">
        <X size={16} />
      </Button>
    </div>
  );
}
export const protocolLabels: Record<string, string> = {
  hysteria2: "Hysteria2",
  tuic: "TUIC",
  anytls: "AnyTLS",
  snell: "Snell v6",
  "vless-ws": "VLESS + WS",
  "vless-reality": "VLESS + Reality",
};
export function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}
