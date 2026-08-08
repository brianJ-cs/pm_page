/* Supabase 設定 —— 兩支 HTML 都讀這一支。
 *
 * anon key 設計上就是公開的（安全靠資料庫那邊的 RLS policy），所以直接寫在這裡沒問題。
 * 絕對不要放 service_role key —— 那把是全權限的。
 *
 * 佔位符還沒換掉之前，PlanSync.ok() 會回 false，兩支都完全走原本的 localStorage，
 * 跟沒接後端一模一樣。這也是 rollback：把下面兩個值清空就退回單機版。
 */
window.SUPABASE = {
  url:     'https://ezzkxmxrzczvhoqjkliy.supabase.co',   // Supabase → Settings → API → Project URL
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6emt4bXhyemN6dmhvcWprbGl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3ODI0MTIsImV4cCI6MjEwMDM1ODQxMn0.OuBo0u1-8rL9FWvuHFgS9kSX1E7yZiQUzCaU9jNwZaA',               // 同一頁的 anon public key

  /* 商品圖丟去哪個 Storage bucket。Supabase → Storage → New bucket，
     名字打一樣、勾 Public bucket。圖不進資料庫，plan 裡只留一串網址。 */
  bucket: 'product-images'
};
