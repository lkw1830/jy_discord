# jy_discord

```sudo tee /etc/systemd/system/discord-bot.service <<'EOF'
[Unit]
Description=Discord Bot
After=network.target

[Service]
WorkingDirectory=/home/ubuntu/discordjs
ExecStart=/usr/bin/node /home/ubuntu/discordjs/index.js
Restart=always
EnvironmentFile=/home/ubuntu/discordjs/.env
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF```

### After saving the file, don’t forget to enable and start it:
sudo systemctl daemon-reload
sudo systemctl enable --now discord-bot

### Enable auto-start
sudo systemctl enable discord-bot

### Reload 
sudo systemctl restart discord-bot
