import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/tokens.css'
import './styles/app.css'

createApp(App).use(createPinia()).mount('#app')

// Packaged-app smoke evidence reads this marker to prove the renderer actually
// mounted, rather than merely loading a document.
document.documentElement.dataset.appShellMounted = 'true'
