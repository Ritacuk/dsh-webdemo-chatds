import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { initStore } from './store/workspace.js'
import './app/global.css'
import './app/theme.css'

void initStore()
const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(<App />)
}
