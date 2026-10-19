import { registry } from "@web/core/registry";
import { titleService } from "@web/core/browser/title_service";

const BRAND = "Snaphomz CRM";

/**
 * Odoo falls back to "Odoo" as the browser tab title when no action is open.
 * Wrap the standard title service and show the Snaphomz name instead.
 */
export const snaphomzTitleService = {
    ...titleService,
    start(...args) {
        const base = titleService.start(...args);
        const brand = () => {
            if (document.title === "Odoo") {
                document.title = BRAND;
            } else if (/^\(\d+\) Odoo$/.test(document.title)) {
                document.title = document.title.replace(/Odoo$/, BRAND);
            }
        };
        brand();
        return {
            get current() {
                return base.current;
            },
            getParts: base.getParts,
            setCounters(counters) {
                base.setCounters(counters);
                brand();
            },
            setParts(parts) {
                base.setParts(parts);
                brand();
            },
        };
    },
};

registry.category("services").add("title", snaphomzTitleService, { force: true });
