export function loginPage(reset = false): Response {
  const title = reset ? "设置密码 / Set password" : "登录 Nex / Sign in"
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:#17263d;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}main{width:min(420px,calc(100% - 40px));padding:36px;background:white;border:1px solid #e1e5ec;border-radius:20px}h1{font-size:28px;margin:0 0 8px}p{color:#65758a;font-size:14px;line-height:1.6}label{display:block;font-size:14px;margin:22px 0 8px}input,button{width:100%;padding:12px;border:1px solid #cdd5df;border-radius:8px;font:inherit}button{background:#203a5e;color:white;border:0;margin-top:24px;cursor:pointer}button:disabled{opacity:.5}a{color:#203a5e}#message{min-height:24px;color:#a12e35}small{color:#65758a;line-height:1.6;display:block;margin-top:24px}</style></head><body><main><h1>Nex</h1><p>${title}</p><form>
  ${reset ? '' : '<label for="email">邮箱 / Email</label><input id="email" type="email" autocomplete="username" required>'}
  <label for="password">${reset ? '新密码 / New password' : '密码 / Password'}</label><input id="password" type="password" autocomplete="${reset ? 'new-password' : 'current-password'}" minlength="12" maxlength="128" required>
  ${reset ? '<label for="confirm">确认密码 / Confirm password</label><input id="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required>' : ''}
  <button>${reset ? '保存密码 / Save password' : '登录 / Sign in'}</button><p id="message" role="status"></p></form><small>${reset ? '链接有效期为一小时，仅可使用一次。密码至少 12 位。' : '仅限受邀用户。忘记密码？请联系管理员获取一次性设置链接。'}<br>${reset ? 'This link expires in one hour and can be used once.' : 'Invitation only. Contact the administrator to reset your password.'}</small></main><script>
  const reset=${reset};const form=document.querySelector('form'),button=document.querySelector('button'),message=document.querySelector('#message');
  form.addEventListener('submit',async e=>{e.preventDefault();message.textContent='';const password=document.querySelector('#password').value;
  if(reset&&password!==document.querySelector('#confirm').value){message.textContent='两次密码不一致 / Passwords do not match';return}
  button.disabled=true;try{const token=new URLSearchParams(location.search).get('token');
  const response=await fetch('/api/auth/'+(reset?'reset-password':'sign-in/email'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(reset?{token,newPassword:password}:{email:document.querySelector('#email').value.trim(),password})});
  if(!response.ok){message.textContent=reset?'链接无效或已过期 / Invalid or expired link':'邮箱或密码错误，或尝试次数过多 / Incorrect credentials or too many attempts';return}
  location.replace(reset?'/login':'/');}catch{message.textContent='连接失败，请重试 / Connection failed'}finally{button.disabled=false}});
  </script></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } })
}
