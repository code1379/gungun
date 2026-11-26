import {
  useState,
  useId,
  isValidElement,
  cloneElement,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { cva } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { X, AlertTriangle, Check } from "lucide-react";
import { errorText, useApp } from "../api";
const button = cva("button", {
  variants: {
    variant: {
      default: "button-primary",
      secondary: "button-secondary",
      ghost: "button-ghost",
      danger: "button-danger",
    },
  },
  defaultVariants: { variant: "secondary" },
});
export function Button({
  variant,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "ghost" | "danger";
}) {
  return (
    <BaseButton
      className={twMerge(clsx(button({ variant }), className))}
      {...props}
    />
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
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop" />
        <Dialog.Popup className={`modal ${wide ? "modal-wide" : ""}`}>
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && (
                <Dialog.Description>{description}</Dialog.Description>
              )}
            </div>
            <Button variant="ghost" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </Button>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  const direct =
    isValidElement<{ id?: string; "aria-describedby"?: string }>(children) &&
    typeof children.type === "string" &&
    ["input", "select", "textarea"].includes(children.type);
  return (
    <div className="field">
      {direct ? <label htmlFor={id}>{label}</label> : <span>{label}</span>}
      {direct
        ? cloneElement(children, {
            id,
            "aria-describedby": hint ? `${id}-hint` : undefined,
          })
        : children}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
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
    <div className="empty">
      <div className="empty-mark">G</div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="actions">{actions}</div>}
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
  return <span className={`badge badge-${tone}`}>{children}</span>;
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
