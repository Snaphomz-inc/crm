import { router, startRouter } from "@web/core/browser/router";
import { patch } from "@web/core/utils/patch";

/**
 * Show /app instead of Odoo's /odoo prefix in the address bar.
 *
 * Odoo's router documents stateToUrl/urlToState as the supported patch
 * points. Old /odoo links keep working: they are parsed as before and the
 * address bar switches to /app on the next navigation.
 */
export const APP_PREFIX = "/app";
const ODOO_PREFIX = /^\/odoo(?=\/|\?|$)/;
const APP_PREFIX_RE = /^\/app(?=\/|\?|$)/;

patch(router, {
    stateToUrl(state) {
        return super.stateToUrl(state).replace(ODOO_PREFIX, APP_PREFIX);
    },
    urlToState(urlObj) {
        if (APP_PREFIX_RE.test(urlObj.pathname)) {
            urlObj.pathname = urlObj.pathname.replace(APP_PREFIX_RE, "/odoo");
        }
        return super.urlToState(urlObj);
    },
});

// The router parsed the address when it loaded, before this patch existed:
// parse it again so deep links such as /app/my-new-leads open the right page.
startRouter();
