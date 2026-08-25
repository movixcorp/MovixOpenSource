"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { getOverlayPortalRoot } from "@/utils/overlayPortal";

// Context for Select
interface SelectContextType {
    value: string;
    label: string;
    syncLabel: (label: string) => void;
    onValueChange: (value: string, label: string) => void;
    open: boolean;
    setOpen: (open: boolean) => void;
    triggerRef: React.RefObject<HTMLButtonElement | null>;
    contentRef: React.RefObject<HTMLDivElement | null>;
}

const SelectContext = React.createContext<SelectContextType | null>(null);

const useSelectContext = () => {
    const context = React.useContext(SelectContext);
    if (!context) {
        throw new Error("Select components must be used within a Select");
    }
    return context;
};

// Main Select component
interface SelectProps {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
}

const Select: React.FC<SelectProps> = ({
    value: controlledValue,
    defaultValue = "",
    onValueChange,
    children
}) => {
    const [internalValue, setInternalValue] = React.useState(defaultValue);
    const [label, setLabel] = React.useState("");
    const [open, setOpen] = React.useState(false);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const contentRef = React.useRef<HTMLDivElement>(null);

    const value = controlledValue !== undefined ? controlledValue : internalValue;

    const handleValueChange = (newValue: string, newLabel: string) => {
        if (controlledValue === undefined) {
            setInternalValue(newValue);
        }
        setLabel(newLabel);
        onValueChange?.(newValue);
        setOpen(false);
    };

    // Close on click outside
    React.useEffect(() => {
        if (!open) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (
                triggerRef.current && 
                !triggerRef.current.contains(e.target as Node) &&
                (!contentRef.current || !contentRef.current.contains(e.target as Node))
            ) {
                setOpen(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [open]);

    // Close on escape
    React.useEffect(() => {
        if (!open) return;

        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };

        document.addEventListener("keydown", handleEscape);
        return () => document.removeEventListener("keydown", handleEscape);
    }, [open]);

    // Allow items to sync their label when they detect they're selected (e.g. on first open)
    const syncLabel = React.useCallback((newLabel: string) => {
        setLabel(prev => prev === newLabel ? prev : newLabel);
    }, []);

    return (
        <SelectContext.Provider value={{ value, label, syncLabel, onValueChange: handleValueChange, open, setOpen, triggerRef, contentRef }}>
            {children}
        </SelectContext.Provider>
    );
};

// SelectValue
interface SelectValueProps {
    placeholder?: string;
}

const SelectValue: React.FC<SelectValueProps> = ({ placeholder }) => {
    const { label } = useSelectContext();
    return <span className="truncate">{label || placeholder}</span>;
};

// SelectTrigger
interface SelectTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    className?: string;
    children: React.ReactNode;
}

const SelectTrigger = React.forwardRef<HTMLButtonElement, SelectTriggerProps>(
    ({ className, children, ...props }, ref) => {
        const { open, setOpen, triggerRef } = useSelectContext();

        // Merge refs
        const mergedRef = (node: HTMLButtonElement) => {
            (triggerRef as React.MutableRefObject<HTMLButtonElement | null>).current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
        };

        return (
            <button
                ref={mergedRef}
                type="button"
                onClick={() => setOpen(!open)}
                className={cn(
                    "flex h-10 w-full items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white",
                    "ring-offset-black placeholder:text-white/40",
                    "hover:bg-white/10 hover:border-white/20",
                    "focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:ring-offset-2",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    "transition-all duration-200",
                    className
                )}
                {...props}
            >
                {children}
                <motion.div
                    animate={{ rotate: open ? 180 : 0 }}
                    transition={{ duration: 0.2, ease: "easeInOut" }}
                >
                    <ChevronDown className="h-4 w-4 text-white opacity-50" />
                </motion.div>
            </button>
        );
    }
);
SelectTrigger.displayName = "SelectTrigger";

// SelectContent
interface SelectContentProps {
    className?: string;
    children: React.ReactNode;
}

const SelectContent: React.FC<SelectContentProps> = ({ className, children }) => {
    const { open, setOpen, triggerRef, contentRef } = useSelectContext();
    const [position, setPosition] = React.useState<{
        top?: number;
        bottom?: number;
        left: number;
        width: number;
        placement: 'top' | 'bottom';
    }>({ top: 0, left: 0, width: 0, placement: 'bottom' });

    // Calculate position
    const updatePosition = React.useCallback(() => {
        if (triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            const spaceBelow = viewportHeight - rect.bottom;
            const spaceAbove = rect.top;

            // Simple logic: if less than 250px below and more space above, go up
            const placement = (spaceBelow < 250 && spaceAbove > spaceBelow) ? 'top' : 'bottom';

            if (placement === 'top') {
                setPosition({
                    bottom: viewportHeight - rect.top + 4,
                    left: rect.left,
                    width: rect.width,
                    placement: 'top'
                });
            } else {
                setPosition({
                    top: rect.bottom + 4,
                    left: rect.left,
                    width: rect.width,
                    placement: 'bottom'
                });
            }
        }
    }, [triggerRef]);

    React.useLayoutEffect(() => {
        if (open) {
            updatePosition();
            // Update position on window resize
            window.addEventListener('resize', updatePosition);
            return () => window.removeEventListener('resize', updatePosition);
        }
    }, [open, updatePosition]);

    // Stop Lenis smooth scroll while dropdown is open to prevent interference
    React.useEffect(() => {
        if (!open) return;
        const lenis = (window as any).lenis;
        if (lenis) lenis.stop();
        return () => {
            const lenisInstance = (window as any).lenis;
            if (lenisInstance) lenisInstance.start();
        };
    }, [open]);

    // Close on wheel/touch outside the content (replaces scroll listener for Lenis compat)
    React.useEffect(() => {
        if (!open) return;

        const handleWheel = (e: WheelEvent) => {
            if (contentRef.current && contentRef.current.contains(e.target as Node)) {
                return;
            }
            setOpen(false);
        };

        const handleTouchMove = (e: TouchEvent) => {
            if (contentRef.current && contentRef.current.contains(e.target as Node)) {
                return;
            }
            setOpen(false);
        };

        window.addEventListener("wheel", handleWheel, { passive: true, capture: true });
        window.addEventListener("touchmove", handleTouchMove, { passive: true, capture: true });
        return () => {
            window.removeEventListener("wheel", handleWheel, { capture: true } as EventListenerOptions);
            window.removeEventListener("touchmove", handleTouchMove, { capture: true } as EventListenerOptions);
        };
    }, [open, setOpen, contentRef]);

    const content = (
        <AnimatePresence mode="wait">
            {open && (
                <motion.div
                    ref={contentRef}
                    initial={{
                        opacity: 0,
                        scale: 0.95,
                        y: position.placement === 'bottom' ? -8 : 8
                    }}
                    animate={{
                        opacity: 1,
                        scale: 1,
                        y: 0
                    }}
                    exit={{
                        opacity: 0,
                        scale: 0.95,
                        y: position.placement === 'bottom' ? -8 : 8
                    }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    data-lenis-prevent
                    style={{
                        position: "fixed",
                        top: position.placement === 'bottom' ? position.top : undefined,
                        bottom: position.placement === 'top' ? position.bottom : undefined,
                        left: position.left,
                        width: position.width,
                        zIndex: 100000,
                        overscrollBehavior: 'contain',
                        transformOrigin: position.placement === 'bottom' ? 'top center' : 'bottom center'
                    }}
                    className={cn(
                        "overflow-hidden rounded-lg border border-white/10 bg-gray-900/95 text-white shadow-xl backdrop-blur-xl",
                        "max-h-80 overflow-y-auto",
                        className
                    )}
                >
                    <div className="p-1">
                        {children}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );

    return createPortal(content, getOverlayPortalRoot());
};

// SelectItem
interface SelectItemProps {
    value: string;
    className?: string;
    children: React.ReactNode;
}

const SelectItem: React.FC<SelectItemProps> = ({ value, className, children }) => {
    const { value: selectedValue, onValueChange, syncLabel } = useSelectContext();
    const isSelected = selectedValue === value;

    // Extract text content from children for label
    const getTextContent = (node: React.ReactNode): string => {
        if (typeof node === 'string') return node;
        if (typeof node === 'number') return String(node);
        if (Array.isArray(node)) return node.map(getTextContent).join('');
        if (React.isValidElement(node) && node.props.children) {
            return getTextContent(node.props.children);
        }
        return '';
    };

    // Sync label when this item is selected (handles initial controlled value)
    React.useEffect(() => {
        if (isSelected) {
            syncLabel(getTextContent(children));
        }
    }, [isSelected]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleClick = () => {
        const label = getTextContent(children);
        onValueChange(value, label);
    };

    return (
        <motion.button
            type="button"
            onClick={handleClick}
            whileHover={{ backgroundColor: "rgba(255, 255, 255, 0.1)" }}
            whileTap={{ scale: 0.98 }}
            className={cn(
                "relative flex w-full cursor-pointer select-none items-center rounded-md py-2 pl-8 pr-2 text-sm outline-none",
                "text-white/80 hover:text-white",
                "transition-colors duration-150",
                isSelected && "text-white bg-white/5",
                className
            )}
        >
            <span className="absolute left-2 flex h-4 w-4 items-center justify-center">
                <AnimatePresence>
                    {isSelected && (
                        <motion.div
                            initial={{ scale: 0, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0, opacity: 0 }}
                            transition={{ duration: 0.15 }}
                        >
                            <Check className="h-4 w-4 text-red-500" />
                        </motion.div>
                    )}
                </AnimatePresence>
            </span>
            {children}
        </motion.button>
    );
};

// SelectGroup (simple wrapper)
const SelectGroup: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return <div className="py-1">{children}</div>;
};

// SelectLabel
interface SelectLabelProps {
    className?: string;
    children: React.ReactNode;
}

const SelectLabel: React.FC<SelectLabelProps> = ({ className, children }) => {
    return (
        <div className={cn("py-1.5 pl-8 pr-2 text-sm font-semibold text-white/50", className)}>
            {children}
        </div>
    );
};

// SelectSeparator
const SelectSeparator: React.FC<{ className?: string }> = ({ className }) => {
    return <div className={cn("-mx-1 my-1 h-px bg-white/10", className)} />;
};

export {
    Select,
    SelectGroup,
    SelectValue,
    SelectTrigger,
    SelectContent,
    SelectLabel,
    SelectItem,
    SelectSeparator,
};
