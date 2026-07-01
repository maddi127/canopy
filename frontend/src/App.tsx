import { BrowserRouter as Router, Routes, Route, Outlet } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AuthProvider } from './context/AuthContext';
import RequireAuth from './components/RequireAuth';
import AuthPage from './pages/AuthPage';
import MyProjectsPage from './pages/MyProjectsPage';

import HomePage from './pages/HomePage';
import AddressPage from './pages/AddressPage';
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
import DiyReviewPage         from './pages/DiyReviewPage';
import DiyPlantsPage         from './pages/DiyPlantsPage';
import Yard3DPage            from './pages/Yard3DPage';
import DiyAutoLayoutPage     from './pages/DiyAutoLayoutPage';
import DiySiteRevealPage     from './pages/DiySiteRevealPage';

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Router>
          <div className="min-h-screen bg-soil-100">
            <Routes>
              {/* Auth + saved projects */}
              <Route path="/auth"     element={<AuthPage />} />
              <Route path="/projects" element={<RequireAuth><MyProjectsPage /></RequireAuth>} />

              <Route path="/" element={<HomePage />} />
              <Route path="/start" element={<AddressPage />} />
              <Route path="/preferences" element={<PreferencesGoalsPage nextPath="/diy/boundary" skipPhoto />} />
              <Route path="/payment"     element={<PaymentPage />} />

              {/* DIY: preferences is open; sign-in is required from the boundary step on */}
              <Route path="/diy/preferences"     element={<DiyPreferencesPage />} />
              <Route element={<RequireAuth><Outlet /></RequireAuth>}>
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
                <Route path="/diy/auto-layout"     element={<DiyAutoLayoutPage />} />
                <Route path="/diy/site-reveal"     element={<DiySiteRevealPage />} />
                <Route path="/diy/review"          element={<DiyReviewPage />} />
                <Route path="/diy/plant-options"   element={<DiyPlantsPage />} />
                <Route path="/diy/yard-3d"         element={<Yard3DPage />} />
                <Route path="/diy/plan"            element={<DiyPlanPage />} />
              </Route>
            </Routes>
          </div>
        </Router>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
