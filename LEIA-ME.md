# Minha Balança

App próprio, sem propaganda, para a balança de bioimpedância Wellmix (protocolo do app **OKOK International**).

## Como funciona

- A balança não aceita conexão: ela só **anuncia** o peso e a impedância pelo Bluetooth. O app escuta esses anúncios e decodifica os bytes (formato documentado pelo projeto open source openScale, com as variantes V20, V11, VF0 e C0).
- A balança mede **peso** e **impedância**. O app calcula: IMC, gordura (% e kg), gordura visceral, músculo esquelético, massa muscular, massa magra, água, proteína, massa óssea, metabolismo basal, idade metabólica, relação cintura/altura (se a cintura for informada), peso ideal, tipo corporal, uma pontuação de 0 a 100 e uma análise em texto com a tendência dos últimos ~30 dias.
- As equações são publicadas (Sun 2003, Janssen 2000, Gallagher 2000, Katch-McArdle, Ashwell 2012). Gordura visceral, osso, proteína e idade metabólica são aproximações. São **estimativas** e podem diferir do app original. Use a "Correção da gordura" no Perfil para alinhar, se quiser.
- Gordura por segmento (braços, tronco, pernas) não é calculada: com eletrodos só nos pés, ela não pode ser medida.
- Tudo fica salvo **só no celular**. Use "Fazer backup" de vez em quando.

## Arquivos

| Arquivo | O que faz |
|---|---|
| `index.html` | Telas do app |
| `css/styles.css` | Visual (claro e escuro) |
| `js/okok.js` | Decodificador do Bluetooth da balança |
| `js/body.js` | Cálculos de composição corporal, faixas, pontuação e análise |
| `js/metrics.js` | Cartões dos índices, barras de faixa e explicações |
| `js/app.js` | Lógica: pesagem, histórico, perfil, backup |
| `sw.js` + `manifest.webmanifest` | Instalar na tela inicial e abrir sem internet |

## Para usar no celular (Android)

1. O app precisa estar publicado num endereço **https://** (GitHub Pages, Vercel, Netlify etc.).
2. Abra o endereço no **Chrome do Android**.
3. Uma vez só: em `chrome://flags`, ative **Experimental Web Platform features** e **Web Bluetooth new permissions backend**, e reinicie o Chrome.
4. Preencha o Perfil, toque em **Pesar** e suba na balança descalço.
5. No menu do Chrome, use **Adicionar à tela inicial** para ter o ícone como um app.

Se a balança não for reconhecida: Perfil → Diagnóstico Bluetooth → marque "Registrar sinais", suba na balança e tire um print da lista.

## Testar no computador

```
python -m http.server 8765
```

Abra http://localhost:8765 e use Perfil → Diagnóstico → **Simular pesagem**.
