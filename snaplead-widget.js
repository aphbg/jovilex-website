/**
 * SnapLead Embeddable Widget
 * Usage: <script src="https://snaplead.jovilex.com/widget.js" data-slug="your-business-slug"></script>
 * 
 * Options via data attributes:
 *   data-slug (required) — your business slug from SnapLead
 *   data-position — "right" (default) or "left"
 *   data-color — button color hex (default: #10B981)
 *   data-text — button text (default: "Get a quick response")
 */
(function() {
  'use strict';

  // Find our script tag
  var scripts = document.querySelectorAll('script[data-slug]');
  var script = scripts[scripts.length - 1];
  if (!script) return;

  var slug = script.getAttribute('data-slug');
  var position = script.getAttribute('data-position') || 'right';
  var brandColor = script.getAttribute('data-color') || '#10B981';
  var btnText = script.getAttribute('data-text') || 'Get a quick response';
  var API_BASE = 'https://snaplead.jovilex.com';

  // State
  var config = null;
  var isOpen = false;
  var isSubmitting = false;

  // Create styles
  var style = document.createElement('style');
  style.textContent = [
    '#snaplead-widget-btn{position:fixed;bottom:24px;' + position + ':24px;z-index:99998;display:flex;align-items:center;gap:8px;padding:14px 22px;background:' + brandColor + ';color:#fff;border:none;border-radius:50px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,0.25);transition:transform 0.2s,box-shadow 0.2s}',
    '#snaplead-widget-btn:hover{transform:translateY(-2px);box-shadow:0 6px 28px rgba(0,0,0,0.35)}',
    '#snaplead-widget-btn svg{flex-shrink:0}',
    '#snaplead-widget-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:99999;display:none;align-items:flex-end;justify-content:' + position + ';padding:20px}',
    '#snaplead-widget-overlay.open{display:flex}',
    '#snaplead-widget-panel{background:#fff;border-radius:16px;width:100%;max-width:400px;max-height:85vh;overflow-y:auto;box-shadow:0 12px 48px rgba(0,0,0,0.2);animation:snaplead-slide-up 0.3s ease}',
    '@keyframes snaplead-slide-up{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}',
    '#snaplead-widget-panel *{box-sizing:border-box;margin:0;padding:0}',
    '.snaplead-w-header{padding:20px 20px 0;display:flex;align-items:center;justify-content:space-between}',
    '.snaplead-w-header h3{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:17px;font-weight:700;color:#111}',
    '.snaplead-w-close{background:none;border:none;font-size:22px;color:#9ca3af;cursor:pointer;padding:4px;line-height:1}',
    '.snaplead-w-close:hover{color:#111}',
    '.snaplead-w-sub{padding:4px 20px 0;font-size:13px;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '.snaplead-w-form{padding:20px}',
    '.snaplead-w-field{margin-bottom:14px}',
    '.snaplead-w-field label{display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '.snaplead-w-field input,.snaplead-w-field textarea,.snaplead-w-field select{width:100%;padding:10px 12px;border:1.5px solid #e5e7eb;border-radius:8px;font-family:inherit;font-size:14px;color:#111;background:#fff;outline:none;transition:border-color 0.2s}',
    '.snaplead-w-field input:focus,.snaplead-w-field textarea:focus,.snaplead-w-field select:focus{border-color:' + brandColor + '}',
    '.snaplead-w-field input::placeholder,.snaplead-w-field textarea::placeholder{color:#9ca3af}',
    '.snaplead-w-field textarea{resize:vertical;min-height:70px}',
    '.snaplead-w-field select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'8\'%3E%3Cpath d=\'M1 1l5 5 5-5\' stroke=\'%236B7280\' stroke-width=\'1.5\' fill=\'none\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:32px}',
    '.snaplead-w-submit{width:100%;padding:12px;background:' + brandColor + ';color:#fff;border:none;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;font-weight:600;cursor:pointer;transition:opacity 0.2s}',
    '.snaplead-w-submit:hover{opacity:0.9}',
    '.snaplead-w-submit:disabled{opacity:0.5;cursor:not-allowed}',
    '.snaplead-w-powered{text-align:center;padding:8px 20px 16px;font-size:11px;color:#9ca3af;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '.snaplead-w-powered a{color:' + brandColor + ';text-decoration:none;font-weight:500}',
    '.snaplead-w-success{padding:40px 20px;text-align:center}',
    '.snaplead-w-success .check-circle{width:56px;height:56px;border-radius:50%;background:' + brandColor + ';display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px}',
    '.snaplead-w-success .check-circle svg{width:28px;height:28px}',
    '.snaplead-w-success h3{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:18px;font-weight:700;color:#111;margin-bottom:6px}',
    '.snaplead-w-success p{font-size:13px;color:#6b7280;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '.snaplead-w-error{background:#fef2f2;border:1px solid #fecaca;color:#dc2626;padding:8px 12px;border-radius:6px;font-size:12px;margin-bottom:12px;display:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '@media(max-width:480px){#snaplead-widget-overlay{padding:0;align-items:flex-end;justify-content:center}#snaplead-widget-panel{border-radius:16px 16px 0 0;max-height:90vh;max-width:100%}}'
  ].join('\n');
  document.head.appendChild(style);

  // Create button
  var btn = document.createElement('button');
  btn.id = 'snaplead-widget-btn';
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>' + btnText;
  document.body.appendChild(btn);

  // Create overlay
  var overlay = document.createElement('div');
  overlay.id = 'snaplead-widget-overlay';
  document.body.appendChild(overlay);

  // Load business config
  fetch(API_BASE + '/api/snaplead-public?action=business&slug=' + encodeURIComponent(slug))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.business) {
        config = data.business;
      }
    })
    .catch(function() {});

  // Button click
  btn.addEventListener('click', function() {
    if (!config) {
      alert('Widget is loading. Please try again in a moment.');
      return;
    }
    openWidget();
  });

  function openWidget() {
    isOpen = true;
    var questions = config.custom_questions || [];
    var fieldsHtml = '<div class="snaplead-w-field"><label>Your name</label><input type="text" id="snaplead-w-name" placeholder="Full name" required></div>';
    fieldsHtml += '<div class="snaplead-w-field"><label>Email</label><input type="email" id="snaplead-w-email" placeholder="you@email.com" required></div>';
    fieldsHtml += '<div class="snaplead-w-field"><label>Phone (optional)</label><input type="tel" id="snaplead-w-phone" placeholder="Your phone number"></div>';

    questions.forEach(function(q) {
      if (q.type === 'textarea') {
        fieldsHtml += '<div class="snaplead-w-field"><label>' + q.label + '</label><textarea id="snaplead-w-q-' + q.id + '" placeholder="' + (q.placeholder || '') + '"' + (q.required ? ' required' : '') + '></textarea></div>';
      } else if (q.type === 'select' && q.options) {
        var opts = q.options.map(function(o) { return '<option value="' + o + '">' + o + '</option>'; }).join('');
        fieldsHtml += '<div class="snaplead-w-field"><label>' + q.label + '</label><select id="snaplead-w-q-' + q.id + '"' + (q.required ? ' required' : '') + '><option value="">Select...</option>' + opts + '</select></div>';
      } else {
        fieldsHtml += '<div class="snaplead-w-field"><label>' + q.label + '</label><input type="text" id="snaplead-w-q-' + q.id + '" placeholder="' + (q.placeholder || '') + '"' + (q.required ? ' required' : '') + '></div>';
      }
    });

    overlay.innerHTML = '<div id="snaplead-widget-panel">' +
      '<div class="snaplead-w-header"><h3>' + (config.business_name || 'Contact Us') + '</h3><button class="snaplead-w-close" onclick="document.getElementById(\'snaplead-widget-overlay\').classList.remove(\'open\')">&times;</button></div>' +
      '<div class="snaplead-w-sub">We\'ll get back to you within minutes.</div>' +
      '<div class="snaplead-w-form">' +
      '<div class="snaplead-w-error" id="snaplead-w-err"></div>' +
      fieldsHtml +
      '<button class="snaplead-w-submit" id="snaplead-w-submit" onclick="window._snapleadSubmit()">Send enquiry</button>' +
      '</div>' +
      '<div class="snaplead-w-powered">Powered by <a href="https://snaplead.jovilex.com" target="_blank">SnapLead</a></div>' +
      '</div>';

    overlay.classList.add('open');
  }

  // Close on overlay click
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) {
      overlay.classList.remove('open');
      isOpen = false;
    }
  });

  // Submit handler (global so inline onclick works)
  window._snapleadSubmit = function() {
    if (isSubmitting) return;
    var errEl = document.getElementById('snaplead-w-err');
    errEl.style.display = 'none';

    var name = document.getElementById('snaplead-w-name').value.trim();
    var email = document.getElementById('snaplead-w-email').value.trim();
    var phone = document.getElementById('snaplead-w-phone').value.trim();

    if (!name || !email) {
      errEl.textContent = 'Please enter your name and email.';
      errEl.style.display = 'block';
      return;
    }

    // Collect question answers
    var answers = {};
    var questions = config.custom_questions || [];
    for (var i = 0; i < questions.length; i++) {
      var q = questions[i];
      var el = document.getElementById('snaplead-w-q-' + q.id);
      if (el) {
        var val = el.value.trim();
        if (q.required && !val) {
          errEl.textContent = 'Please fill in all required fields.';
          errEl.style.display = 'block';
          return;
        }
        answers[q.id] = val;
      }
    }

    isSubmitting = true;
    var submitBtn = document.getElementById('snaplead-w-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    fetch(API_BASE + '/api/snaplead-respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_slug: slug,
        customer_name: name,
        customer_email: email,
        customer_phone: phone || null,
        answers: answers,
        source: 'widget'
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      isSubmitting = false;
      if (data.success) {
        var panel = document.getElementById('snaplead-widget-panel');
        panel.innerHTML = '<div class="snaplead-w-header"><h3>' + (config.business_name || 'Thank You') + '</h3><button class="snaplead-w-close" onclick="document.getElementById(\'snaplead-widget-overlay\').classList.remove(\'open\')">&times;</button></div>' +
          '<div class="snaplead-w-success">' +
          '<div class="check-circle"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div>' +
          '<h3>We\'ve received your enquiry</h3>' +
          '<p>A personalised response is on its way to your email. We\'ll follow up shortly with next steps.</p>' +
          '</div>' +
          '<div class="snaplead-w-powered">Powered by <a href="https://snaplead.jovilex.com" target="_blank">SnapLead</a></div>';
      } else {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send enquiry';
        errEl.textContent = data.error || 'Something went wrong. Please try again.';
        errEl.style.display = 'block';
      }
    })
    .catch(function() {
      isSubmitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send enquiry';
      errEl.textContent = 'Network error. Please try again.';
      errEl.style.display = 'block';
    });
  };
})();
