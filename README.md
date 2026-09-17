# 你畫我猜小遊戲 - 部署說明

這是一套完整可運作的多人連線「你畫我猜」小遊戲，包含：
- 畫布即時同步
- QR Code 分享房間
- 自動判斷搶答先後順序並計分

你**不需要修改任何程式碼**，只要照著下面步驟把它放上網路即可。

## 為什麼需要「部署」而不是直接打開網頁？

因為這個遊戲要讓多人同時連線、同步畫面，需要一台會一直運作的伺服器（Node.js）。
單純打開一個 HTML 檔案是做不到即時連線的，所以要把程式放到一個網路平台上執行。

以下用 **Render.com**（有免費方案，操作最簡單）示範，全程約 5-10 分鐘。

---

## 步驟一：註冊 Render 帳號

1. 前往 https://render.com
2. 用 GitHub 帳號或 Email 註冊（免費）

## 步驟二：把專案放到 GitHub（Render 需要從 GitHub 讀取程式碼）

1. 到 https://github.com 註冊帳號（若還沒有）
2. 建立一個新的 Repository（名稱例如 `draw-guess-game`），設為 Public
3. 把這次拿到的整個 `draw-guess-game` 資料夾內容上傳上去
   - 最簡單的方式：在 GitHub 該 repository 頁面點 **"Add file" → "Upload files"**，
     把 `server.js`、`package.json`、`public` 資料夾整個拖曳上傳，然後按 Commit

## 步驟三：在 Render 建立 Web Service

1. 登入 Render 後，點右上角 **"New +" → "Web Service"**
2. 選擇剛剛上傳的 GitHub Repository，並授權連結
3. 設定如下：
   - **Name**：自訂（例如 draw-guess-game）
   - **Region**：選離你近的（例如 Singapore）
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Instance Type**：選 **Free**
4. 點 **"Create Web Service"**，等待約 1-2 分鐘部署完成

## 步驟四：開始遊戲

部署完成後，Render 會給你一個網址，例如：
```
https://draw-guess-game.onrender.com
```

1. 用電腦或手機打開這個網址
2. 輸入暱稱 → 按「建立新房間」
3. 畫面會顯示 QR Code，讓其他人用手機掃描加入（或直接分享連結）
4. 滿 2 人以上會自動開始，輪流當畫圖者，其他人搶答，答對依「伺服器收到答案的先後順序」自動計分

---

## 小提醒

- **免費方案特性**：Render 免費方案若長時間沒人使用會自動休眠，下次有人打開網址時需等待約 30 秒喚醒，屬正常現象。若要避免這個狀況，之後可以升級付費方案，或改用 Railway.app / Fly.io 等類似平台（步驟大同小異）。
- **修改題庫**：想換題目的話，打開 `server.js`，找到最上面的 `WORD_LIST` 陣列，直接增加或修改裡面的詞語即可。
- **修改每回合時間**：`server.js` 裡的 `ROUND_SECONDS` 可以調整秒數。
- **修改計分規則**：`server.js` 裡搜尋 `points = Math.max(10 - (rank - 1) * 2, 2)`，可自行調整分數公式。
- 若想先在自己電腦測試：安裝 Node.js 後，在資料夾內執行 `npm install` 再執行 `npm start`，用瀏覽器打開 `http://localhost:3000` 即可（僅限同一台電腦測試，手機要連同一個 Wi-Fi 並用電腦的區域網路 IP 才能連得到）。
