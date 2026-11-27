import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import { App } from './App'
import './styles.css'

const root = document.getElementById('root')
if (root === null) throw new Error('Missing application root')

createRoot(root).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)
