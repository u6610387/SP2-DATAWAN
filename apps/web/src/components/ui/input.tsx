import { type InputHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-base outline-none focus:ring-2 focus:ring-[var(--brand)]',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
