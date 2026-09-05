I need you to FIX the Messenger WebView behavior in this existing Postre Messenger ordering project.

PROBLEM:
When a customer taps "Order Online" / opens the ordering page from Messenger, the URL:
https://postrebot.onrender.com/webview
opens in the external browser instead of opening INSIDE the Messenger WebView.

IMPORTANT:
- The project is already deployed successfully on Render.
- Supabase is working.
- Do NOT change the database architecture.
- Do NOT remove existing Messenger bot functionality.
- Do NOT change or expose any secrets.
- Do NOT modify VAPID variables; push notifications are unrelated to this issue.
- The Facebook Page already has this domain whitelisted under:
  Page Settings → Advanced Messaging → Whitelisted domains
- Whitelisted domain:
  https://postrebot.onrender.com
- Actual WebView URL:
  https://postrebot.onrender.com/webview

CURRENT RENDER LOGS:
[supabase] URL configured
[push] VAPID configured — web push notifications ENABLED.
Web ordering URL: https://postrebot.onrender.com/webview
[messenger] webview domain whitelisted: https://postrebot.onrender.com
[db] migration complete (supabase)

TASK:
1. Inspect the entire Messenger integration in the repository.
2. Find the code responsible for:
   - "Order Online"
   - "WEBVIEW"
   - web_url buttons
   - messenger_extensions
   - webview_height_ratio
   - fallback_url
   - Messenger Send API calls
   - Graph API version
3. Determine exactly why Messenger is opening the URL externally.

IMPORTANT BEHAVIOR:
The code currently appears to use a pattern similar to:

{
  type: "web_url",
  url: "https://postrebot.onrender.com/webview",
  title: "Order Now",
  webview_height_ratio: "full",
  messenger_extensions: true,
  fallback_url: "https://postrebot.onrender.com/webview"
}

There also appears to be fallback logic that retries the button with messenger_extensions=false when Meta rejects the WebView request.

DO NOT silently fall back to an external browser.

If the Messenger WebView request fails:
- log the exact Meta API response
- preserve the error
- do not hide the failure by sending a normal external URL button

4. Inspect the current Graph API version being used.
5. Determine the currently supported Messenger API/WebView implementation for this app and update the implementation if necessary.
6. Use the official Meta documentation/current API behavior when deciding what needs to change. Do not assume that an old Messenger Extensions implementation is still valid.

7. Fix the Messenger button so that the customer flow is:

Messenger
  ↓
Order Online
  ↓
Postre ordering website INSIDE Messenger WebView
  ↓
https://postrebot.onrender.com/webview

8. If possible with the current Messenger API, make "Order Online" directly open the WebView instead of requiring an unnecessary second external-link step.

9. Keep:
   - webview_height_ratio = "full" where supported
   - messenger_extensions = true where supported/required
   - correct Messenger WebView configuration
   - existing PSID/customer/order functionality

10. Verify the WebView page itself:
   - HTTPS works
   - no redirect to another domain
   - no JavaScript redirect to window.location/external browser
   - no server-side redirect from /webview
   - no authentication redirect that causes Messenger to leave the WebView
   - Supabase requests do not redirect the page
   - the page loads correctly when opened directly

11. Check whether the WebView page needs the Messenger Extensions SDK. If it is required by the implementation, add it correctly. Do not add duplicate SDKs.

12. Check whether the WebView needs to call Messenger Extensions initialization and whether the current implementation handles the WebView environment correctly.

13. IMPORTANT: Do not solve this by merely adding the domain to App Domains. The Facebook Page already has:
https://postrebot.onrender.com
in Advanced Messaging → Whitelisted domains.

14. Add useful server-side logging around the Messenger Send API request:
   - target URL
   - whether messenger_extensions=true
   - Graph API response status
   - Meta error code/message/type
   - whether fallback was attempted

15. Do NOT log:
   - PAGE_ACCESS_TOKEN
   - APP_SECRET
   - Supabase service key
   - VAPID private key
   - any other secret

16. After making the fix:
   - run TypeScript/build
   - fix any compile errors
   - verify the Messenger payload
   - verify /webview route
   - verify no existing ordering functionality is broken

17. Give me a concise summary of:
   - root cause
   - files changed
   - exact changes made
   - how I should test it from Messenger
   - any Meta Developer/Page setting that still needs to be changed

DO NOT just tell me what to change. Inspect the repository and implement the fix directly.