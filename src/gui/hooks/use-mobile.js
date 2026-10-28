// Adapted from shadcn/ui, MIT. See SHADCN-NOTICE.md.
import * as React from "react";
const MOBILE_QUERY = "(max-width:767px), (pointer:coarse) and (max-height:767px)";
export function useIsMobile() {
    const [isMobile, setIsMobile] = React.useState(() => document.documentElement.dataset.nativeIos === "true" || window.matchMedia(MOBILE_QUERY).matches);
    React.useEffect(() => {
        const mql = window.matchMedia(MOBILE_QUERY);
        const onChange = () => {
            setIsMobile(document.documentElement.dataset.nativeIos === "true" || window.matchMedia(MOBILE_QUERY).matches);
        };
        mql.addEventListener("change", onChange);
        setIsMobile(document.documentElement.dataset.nativeIos === "true" || window.matchMedia(MOBILE_QUERY).matches);
        return () => mql.removeEventListener("change", onChange);
    }, []);
    return !!isMobile;
}
