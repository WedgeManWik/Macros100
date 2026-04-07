import { useState, useEffect } from 'react'
import DietPlanner from './DietPlanner'
import DisclaimerModal from './components/DisclaimerModal'
import './App.css'

function App() {
  const [showDisclaimer, setShowDisclaimer] = useState(false)

  useEffect(() => {
    const accepted = localStorage.getItem('disclaimerAccepted')
    if (!accepted) {
      setShowDisclaimer(true)
    }
  }, [])

  const handleClose = () => {
    localStorage.setItem('disclaimerAccepted', 'true')
    setShowDisclaimer(false)
  }

  return (
    <div className="App">
      <DisclaimerModal show={showDisclaimer} onClose={handleClose} />
      <DietPlanner />
    </div>
  )
}

export default App
