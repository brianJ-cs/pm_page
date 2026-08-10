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

/* 品牌 Logo 庫（logo_page）住在**另一個** Supabase 專案裡。
 * 它本來是獨立的一站，有自己的資料表（companies／logos）和自己的 bucket，
 * 併進來的時候刻意沒有搬家 —— 搬一次要改它的資料、它的 RLS、它的網址，
 * 換來的只是「同一個專案」這件事本身，而這邊要的只是**讀**：
 *   哪個品牌有 logo、那張圖的公開網址是什麼。
 *
 * 所以這裡只放它的 url 和 anon key，而且只拿來 GET 兩張表（見 pullLogos）。
 * 清空這兩個值＝品牌圖回到「只有手動上傳的那幾張」，其他都畫預設的框，
 * 主程式其他功能一個都不受影響。
 */
window.LOGO_SUPABASE = {
  url:     'https://fbtvbdixarkfarwoivef.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZidHZiZGl4YXJrZmFyd29pdmVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyNjQ1MDgsImV4cCI6MjA5OTg0MDUwOH0.VjTDvszOYZUW4qWRJK1UfQH0SMwnHHs49In2oT8YbhA',
  bucket:  'logos'
};
