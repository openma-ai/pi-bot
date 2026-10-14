// Adapted from shadcn/ui, MIT. See SHADCN-NOTICE.md.
import { cn } from "./utils.js";
function Skeleton({ className, ...props }) {
    return (<div data-slot="skeleton" className={cn("animate-pulse rounded-md bg-accent", className)} {...props}/>);
}
export { Skeleton };
