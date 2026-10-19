# Meta lead ads → CRM: setup

Facebook and Instagram instant-form leads reach the CRM within a minute:

```
Lead form submitted ─► Meta webhook ─► n8n (crm.trysnaphomz.com/webhook/…)
  ─► reads the full lead from Meta with the system-user token
  ─► CRM intake ─► Manager › Unassigned intake (Phani / Nrupen assign it)
```

A daily job (07:00 UTC) re-reads the last three days of leads on every form and adds any
that were missed, for example while the Mac was asleep.

You need admin access to the Snaphomz business portfolio in Meta (the one that owns the
Facebook Page), the privacy policy URL of trysnaphomz.com, and about 30 minutes. Meta renames
its menus from time to time; the names below were correct in October 2026.

## 1. Sign in to n8n

n8n runs on this Mac and is never exposed to the internet. Open <http://localhost:5678>.
The first time, it asks you to create the owner account: use your Snaphomz email and a strong
password, and keep them in the team's password manager.

## 2. Create the Meta app

1. Go to <https://developers.facebook.com/apps> › **Create app**.
2. Name **Snaphomz CRM**, contact email your Snaphomz address.
3. Use case: **Other**, then app type **Business**. Connect it to the Snaphomz business
   portfolio.
4. **App settings › Basic**: fill in the **Privacy policy URL** and save. Copy the **App ID**
   and the **App secret** (click *Show*) into the password manager.
5. **App review › Permissions and features** (or **Use cases › Customize**): make sure these
   have at least *Standard access*: `leads_retrieval`, `pages_show_list`,
   `pages_read_engagement`, `pages_manage_metadata`, `pages_manage_ads`,
   `business_management`, `ads_read`. Standard access is enough because the app, the Page and
   the system user all belong to the same business, so no App Review is needed.

You don't need to set up webhooks in the app dashboard: n8n registers the webhook itself
when the workflow is published.

## 3. Create the system user and its token

In **Meta Business Settings** (<https://business.facebook.com/settings>):

1. **Users › System users › Add**: name **Snaphomz CRM**, role **Employee**.
2. **Assign assets** to it:
   * the **Facebook Page**: full control;
   * the **ad account** that runs the lead ads: *View performance* (used for campaign names);
   * the **Snaphomz CRM** app: *Develop app*.
3. **Generate new token**: app **Snaphomz CRM**, expiration **Never**, and tick the
   permissions listed in step 2.5. Copy the token into the password manager (Meta shows it
   only once).
4. **Integrations › Leads access** (Lead Access Manager): if access to the Page's leads is
   restricted, add the **Snaphomz CRM** app and the system user. If no restriction is set,
   everyone with Page access can read leads and there is nothing to do.

## 4. Put the values into n8n

At <http://localhost:5678> › **Overview › Credentials**, open each one and paste:

| Credential | Field | Value |
|---|---|---|
| **Meta app (webhooks)** | Access Token | `<App ID>\|<App secret>` (the two joined by a vertical bar) |
|  | App Secret | the App secret |
| **Meta Graph API (system user)** | Access Token | the system-user token |

Then open the workflow **Snaphomz | Meta Lead Ads -> Odoo intake**, double-click the
**Meta Page leads** node and set **App ID** to the App ID. Save.

## 5. Connect the Facebook Page

```bash
scripts/connect_meta_pages.sh
```

It subscribes every Page the system user manages to new-lead events and lists their forms,
for example `Snaphomz (1234567890): subscribed to new leads` followed by the form names. Run it
again whenever a Page is added. It prints no tokens.

## 6. Publish the workflows

In n8n, open each of these and click **Publish** (top right):

1. **Snaphomz | Integration error alert**: a failed delivery shows up in the CRM under
   **Manager › Failed integrations**.
2. **Snaphomz | Meta Lead Ads -> Odoo intake**: publishing registers the webhook with Meta.
3. **Snaphomz | Meta daily reconciliation**.

## 7. Test

1. Open Meta's **Lead Ads Testing Tool**: <https://developers.facebook.com/tools/lead-ads-testing>.
2. Pick the Page and a form, then **Create lead** (delete any earlier test lead for that form
   first: the tool allows one per form).
3. Within a minute the lead appears in the CRM under **Manager › Unassigned intake**, with
   source *facebook* and the form's answers. n8n's **Executions** list stays empty on success
   (only failures are kept).
4. Archive the test buyer in the CRM.

## 8. Go live

In the app dashboard, switch **App mode** from *Development* to **Live**. Meta only delivers
real leads (not just test leads) to live apps. Then submit one genuine lead from a live ad or
form preview, and check that it arrives.

## Keep in mind

* **This Mac must be on, awake and online.** The CRM and n8n run here through the Cloudflare
  Tunnel. While it is offline Meta retries for a while, and the daily job picks up anything
  from the last three days. Move to a server before relying on this for paid campaigns at
  volume.
* The system-user token never expires, but it stops working if the system user is removed or
  loses the Page. The App secret only changes if someone resets it: update the credential if so.
* New Page or new form: new forms on a connected Page work automatically. For a new Page,
  assign it to the system user, then run step 5 again.

## Troubleshooting

* **A test lead never arrives and n8n Executions shows nothing.** Meta's delivery never got
  through. Check that the tunnel and n8n are up
  (`curl -X POST https://crm.trysnaphomz.com/webhook/uptime-check` returns n8n's
  "not registered" message) and that the intake workflow is published. n8n checks Meta's signature (the `X-Hub-Signature`
  header) and silently ignores deliveries that fail it. If Meta has stopped sending that
  header, clear **App Secret** in the *Meta app (webhooks)* credential. Leads are still read
  from Meta with your own token, so they can't be forged.
* **Executions shows a failure at "Page access token" or "Fetch lead".** The system user
  can't read the Page or its leads: re-check step 3 (Page assignment, token permissions, Leads
  access). The CRM lists the failure under **Manager › Failed integrations**.
* **Campaign name is empty.** The system user has no access to the ad account (step 3.2). The
  lead itself is fine.
