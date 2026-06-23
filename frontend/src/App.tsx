import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import HomePage from './pages/HomePage';
import PreferencesGoalsPage from './pages/PreferencesGoalsPage';
import PaymentPage from './pages/PaymentPage';

// ── DIY flow ──────────────────────────────────────────────────────────────────
import DiyPreferencesPage    from './pages/DiyPreferencesPage';
import DiyConceptPage        from './pages/DiyConceptPage';
import DiyPaymentPage        from './pages/DiyPaymentPage';
import DiyBoundaryPage       from './pages/DiyBoundaryPage';
import DiyFeatureConfirmPage from './pages/DiyFeatureConfirmPage';
import DiyRefinePage         from './pages/DiyRefinePage';
import DiyFinalRenderPage    from './pages/DiyFinalRenderPage';
import DiyPlanPage           from './pages/DiyPlanPage';
import DiyPlanRevealPage     from './pages/DiyPlanRevealPage';
import DiyPlantSelectPage    from './pages/DiyPlantSelectPage';
import DiyLayoutPage         from './pages/DiyLayoutPage';
import DiyPlacementPage      from './pages/DiyPlacementPage';

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <div className="min-h-screen bg-soil-100">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/preferences" element={<PreferencesGoalsPage nextPath="/diy/boundary" skipPhoto />} />
            <Route path="/payment"     element={<PaymentPage />} />

            {/* DIY flow */}
            <Route path="/diy/preferences"     element={<DiyPreferencesPage />} />
            <Route path="/diy/concept"         element={<DiyConceptPage />} />
            <Route path="/diy/payment"         element={<DiyPaymentPage />} />
            <Route path="/diy/boundary"        element={<DiyBoundaryPage />} />
            <Route path="/diy/plants"          element={<DiyPlantSelectPage />} />
            <Route path="/diy/feature-confirm" element={<DiyFeatureConfirmPage />} />
            <Route path="/diy/plan-reveal"     element={<DiyPlanRevealPage />} />
            <Route path="/diy/refine"          element={<DiyRefinePage />} />
            <Route path="/diy/render"          element={<DiyFinalRenderPage />} />
            <Route path="/diy/layout"          element={<DiyLayoutPage />} />
            <Route path="/diy/placement"       element={<DiyPlacementPage />} />
            <Route path="/diy/plan"            element={<DiyPlanPage />} />
          </Routes>
        </div>
      </Router>
    </QueryClientProvider>
  );
}

export default App;
