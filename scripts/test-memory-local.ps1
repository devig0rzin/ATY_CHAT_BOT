# Script de teste local: simula sequência de mensagens para validar memória
# Execute com o worker local rodando: npm run dev:local

$base = "http://127.0.0.1:8787"
$headers = @{ 'Content-Type' = 'application/json' }

$seq = @(
  @{ EventType = 'messages'; message = @{ messageid = 'm1'; sender_pn = '5511999999999@s.whatsapp.net'; text = 'Meu nome é Lucas' } },
  @{ EventType = 'messages'; message = @{ messageid = 'm2'; sender_pn = '5511999999999@s.whatsapp.net'; text = 'Tenho uma clínica' } },
  @{ EventType = 'messages'; message = @{ messageid = 'm3'; sender_pn = '5511999999999@s.whatsapp.net'; text = 'Quero automatizar o atendimento pelo WhatsApp' } }
)

foreach ($payload in $seq) {
  $body = ($payload | ConvertTo-Json -Depth 10)
  Write-Host "POST /webhooks/uazapi -> $body"
  Invoke-RestMethod -Uri "$base/webhooks/uazapi" -Method Post -Headers $headers -Body $body
}

Write-Host "Teste concluído. Verifique o banco local (D1) para contatos, conversations, messages e conversation_memory."