import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import "./toast.css";
const TOAST_DURATION_MS = 2600;
type Toast = { id: number; message: string };
type ToastContextValue = { showToast: (message: string) => void };
const ToastContext = createContext<ToastContextValue | null>(null);
export function useToast(): ToastContextValue { const value = useContext(ToastContext); if (!value) throw new Error("useToast must be used within ToastProvider"); return value; }
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]); const nextIdRef = useRef(0);
  const showToast = useCallback((message: string) => { const id = ++nextIdRef.current; setToasts((current) => [...current, { id, message }]); setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), TOAST_DURATION_MS); }, []);
  return <ToastContext.Provider value={{ showToast }}>{children}<div className="toast-stack" aria-live="polite">{toasts.map((toast) => <p key={toast.id} className="toast" role="status" data-testid="toast">{toast.message}</p>)}</div></ToastContext.Provider>;
}
