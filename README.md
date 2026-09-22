# codex-reset-bot

Codex の利用枠リセット情報を Discord に表示するボットです。

- 次のリセット予定・直近のリセット・統計・履歴グラフ・最新のお知らせを1分ごとに更新
- ボタンで過去のリセットを3件ずつ表示
- `/notify` で `ping-reset` ロールを付け外しし、リセット時にメンション（通知は24時間で自動削除）
- `/language` で English / 简体中文 / 繁體中文 / 日本語 / 한국어 を切り替え

データと投稿の翻訳は [codex-resets.com](https://codex-resets.com/)（[@wong2__](https://x.com/wong2__)）の公開 API とサイトを使っています。OpenAI とは無関係です。

## 起動方法

Node.js 20 以上と、グラフの日中韓フォントが必要です。

```bash
sudo apt install fonts-noto-cjk
npm install
cp .env.example .env   # DISCORD_TOKEN と DISCORD_CLIENT_ID を入れる
npm start
```

起動ログの invite URL からサーバーに招待し、`/set-channel` で表示先を選びます。
